import { Types } from "mongoose";
import { env } from "../config/env";
import { decryptJson } from "../lib/crypto";
import { toErrorMessage } from "../lib/errors";
import { logger } from "../lib/logger";
import { Connection } from "../models/Connection";
import {
  Run,
  runExpiryDate,
  isTerminalStatus,
  TERMINAL_RUN_STATUSES,
  type RunDoc,
} from "../models/Run";
import { Workflow } from "../models/Workflow";
import { handleRunFailure } from "./errorHandler";
import { resolveValue } from "./expression";
import {
  createInitialState,
  runGraph,
  type GraphEdge,
  type GraphNode,
  type QueueItem,
  type StepOutcome,
  type TraversalState,
} from "./graph";
import { getNodeDefinition, requireNodeDefinition } from "./registry";
import type {
  ExpressionScope,
  NodeExecutionContext,
  RunStepRecord,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

export interface WebhookResponsePayload {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  hasBody: boolean;
}

export interface ExecuteResult {
  status: "success" | "error" | "waiting" | "cancelled";
  error?: string;
  errorNodeId?: string;
  resumeAt?: Date;
  lastOutput?: unknown;
  webhookResponse?: WebhookResponsePayload;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  return { value };
}

/** Reads and decrypts a saved connection, caching within a single run. */
function makeConnectionResolver() {
  const cache = new Map<string, Record<string, unknown>>();
  return async (id: string): Promise<Record<string, unknown>> => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (!Types.ObjectId.isValid(id))
      throw new Error(`Invalid connection id "${id}"`);

    const connection = await Connection.findById(id).select("+data").lean();
    if (!connection)
      throw new Error("The selected connection no longer exists");

    const config = decryptJson<Record<string, unknown>>(
      connection.data as string,
    );
    cache.set(id, config);
    return config;
  };
}

/** Resolves node params, skipping properties flagged `resolveExpressions: false`. */
function resolveParams(
  node: WorkflowNode,
  scope: ExpressionScope,
): Record<string, unknown> {
  const definition = getNodeDefinition(node.type);
  const skip = new Set(
    (definition?.properties ?? [])
      .filter((property) => property.resolveExpressions === false)
      .map((property) => property.name),
  );

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.params ?? {})) {
    resolved[key] = skip.has(key) ? value : resolveValue(value, scope);
  }
  return resolved;
}

/** Maps workflow nodes onto the shape the pure traversal engine expects. */
function toGraphNodes(nodes: WorkflowNode[]): GraphNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
    inputs: getNodeDefinition(node.type)?.inputs ?? 1,
    disabled: node.disabled,
    onError: node.onError,
  }));
}

/**
 * Executes (or resumes) a single run.
 *
 * All graph walking lives in `graph.ts`; this function supplies the side effects —
 * expression resolution, credentials, retries and persistence.
 */
export async function executeRun(
  runId: string,
  workerId = "inline",
): Promise<ExecuteResult> {
  /*
   * Claim the run atomically.
   *
   * Containers get restarted (deploys, health checks, OOM), which leaves jobs
   * locked and later reclaimed. Without this guard the reclaimed job would run
   * a second time — resending webhooks, re-adding spreadsheet rows and
   * re-sending emails. A run executes at most once; the only way back in is by
   * resuming persisted state, below.
   */
  const staleCutoff = new Date(Date.now() - env.engine.stalledAfterMs);
  const claimed = await Run.findOneAndUpdate(
    {
      _id: runId,
      status: { $nin: TERMINAL_RUN_STATUSES },
      $or: [
        { lockedAt: { $exists: false } },
        { lockedAt: null },
        { lockedAt: { $lt: staleCutoff } },
        { lockedBy: workerId },
      ],
    },
    { $set: { status: "running", lockedBy: workerId, lockedAt: new Date() } },
    { new: true },
  ).select("+state");

  if (!claimed) {
    // Either the run already finished, or another worker holds it.
    const existing = await Run.findById(runId).select("status error").lean();
    if (!existing) return { status: "error", error: "Run not found" };

    if (isTerminalStatus(existing.status)) {
      logger.debug(
        { runId, status: existing.status },
        "Run already finished — not re-running",
      );
      return existing.status === "success"
        ? { status: "success" }
        : {
            status: existing.status === "cancelled" ? "cancelled" : "error",
            error: existing.error ?? undefined,
          };
    }

    logger.warn({ runId }, "Run is locked by another worker — skipping");
    return { status: "error", error: "Run is already executing elsewhere" };
  }

  const run = claimed;

  const workflow = await Workflow.findById(run.workflow).lean();
  if (!workflow) {
    await finishRun(run, "error", "Workflow was deleted");
    return { status: "error", error: "Workflow was deleted" };
  }

  const workflowNodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
  const workflowEdges = (workflow.edges ?? []) as unknown as WorkflowEdge[];
  const nodeById = new Map(workflowNodes.map((node) => [node.id, node]));

  const controller = new AbortController();
  const timeoutMs = Number(
    workflow.settings?.timeoutMs ?? env.engine.runTimeoutMs,
  );
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const getConnection = makeConnectionResolver();
  const triggerPayload = asRecord(run.trigger?.payload ?? {});
  const variables = asRecord(workflow.variables ?? {});
  const nodeNameToId = Object.fromEntries(
    workflowNodes.map((node) => [node.name, node.id]),
  );

  const savedState = run.get("state") as TraversalState | undefined;
  /**
   * runGraph mutates this object in place, so the execute callback below always
   * sees the live node outputs when building expression scopes.
   */
  const currentState: TraversalState = savedState ?? createInitialState();
  let webhookResponse: WebhookResponsePayload | undefined;
  const logsByNode = new Map<string, string[]>();
  const triesByNode = new Map<string, number>();

  run.set("status", "running");
  if (!run.startedAt) run.set("startedAt", new Date());

  // A fresh run records the trigger itself as step zero.
  if (!savedState) {
    const triggerNode = nodeById.get(String(run.trigger?.nodeId ?? ""));
    if (triggerNode) {
      pushStep(run, {
        nodeId: triggerNode.id,
        nodeName: triggerNode.name,
        nodeType: triggerNode.type,
        status: "success",
        output: triggerPayload,
        startedAt: new Date(),
        finishedAt: new Date(),
        durationMs: 0,
        tries: 1,
      });
    }
  }
  await run.save();

  const buildScope = (
    state: TraversalState,
    input: Record<string, unknown>,
    item: QueueItem,
  ): ExpressionScope => {
    const nodeScope: Record<string, { json: unknown }> = {};
    for (const [name, id] of Object.entries(nodeNameToId)) {
      const pinned = nodeById.get(id)?.pinnedData;
      nodeScope[name] = { json: state.nodeOutputs[id] ?? pinned ?? null };
    }
    return {
      $json: input,
      $trigger: triggerPayload,
      $node: nodeScope,
      $vars: variables,
      $runId: String(run._id),
      $workflowId: String(workflow._id),
      $workflowName: String(workflow.name),
      $now: new Date().toISOString(),
      $timestamp: Date.now(),
      $itemIndex: item.loop?.index ?? 0,
      $itemCount: item.loop?.total ?? 1,
    };
  };

  const result = await runGraph({
    nodes: toGraphNodes(workflowNodes),
    edges: workflowEdges as GraphEdge[],
    startNodeId: String(run.trigger?.nodeId ?? ""),
    startData: triggerPayload,
    executeStartNode: Boolean(run.trigger?.executeStartNode),
    state: currentState,
    isCancelled: () => controller.signal.aborted || Date.now() > deadline,
    cancelMessage: `Run exceeded the ${timeoutMs}ms time limit`,

    async execute(graphNode, item) {
      const node = nodeById.get(graphNode.id);
      if (!node) throw new Error("Step disappeared from the workflow mid-run");

      const definition = requireNodeDefinition(node.type);
      if (!definition.execute) {
        throw new Error(`"${node.name}" cannot run here — it is a trigger`);
      }

      const logs: string[] = [];
      const maxTries = node.retryOnFail
        ? Math.max(1, Number(node.maxTries ?? 3))
        : 1;
      let tries = 0;
      let lastError: unknown;

      while (tries < maxTries) {
        tries += 1;
        try {
          // The scope is rebuilt per attempt so {{ $now }} reflects the retry.
          const scope = buildScope(currentState, item.input, item);
          const ctx: NodeExecutionContext = {
            node,
            params: resolveParams(node, scope),
            rawParams: node.params ?? {},
            input: item.input,
            arrivals: item.arrivals,
            itemIndex: item.loop?.index,
            itemCount: item.loop?.total,
            scope,
            runId: String(run._id),
            workflowId: String(workflow._id),
            getConnection,
            resolve: (value) => resolveValue(value, scope),
            log: (message) =>
              logs.push(`${new Date().toISOString()}  ${message}`),
            signal: controller.signal,
          };

          const outcome = await definition.execute(ctx);
          logsByNode.set(node.id, logs);
          triesByNode.set(node.id, tries);

          if (outcome.kind === "output") {
            const response = (outcome.data as Record<string, unknown>)
              .__webhookResponse;
            if (response)
              webhookResponse = response as unknown as WebhookResponsePayload;
          }
          return outcome as StepOutcome;
        } catch (error) {
          lastError = error;
          if (tries < maxTries) {
            logs.push(
              `${new Date().toISOString()}  Attempt ${tries} failed: ${toErrorMessage(error)} — retrying`,
            );
            await sleep(
              Number(node.waitBetweenTriesMs ?? 1000),
              controller.signal,
            );
          }
        }
      }

      logsByNode.set(node.id, logs);
      triesByNode.set(node.id, tries);
      throw lastError ?? new Error("Step returned no result");
    },

    async onStep(record) {
      pushStep(run, {
        ...record,
        logs: logsByNode.get(record.nodeId) ?? [],
        tries: triesByNode.get(record.nodeId) ?? 1,
      } as RunStepRecord);

      /*
       * Persist the traversal state after EVERY step, not just on a Wait.
       *
       * This is what makes an interrupted run resumable. If the process dies
       * here, the reclaimed job picks up from the queue as it stands — the
       * steps already executed are in `state.executed` and will not run again.
       * Skipping this write is what caused duplicate webhooks and spreadsheet
       * rows after a container restart.
       */
      run.set("state", currentState);
      run.set("lockedAt", new Date());

      await run.save().catch((error) => {
        logger.warn(
          { runId, err: toErrorMessage(error) },
          "Could not persist run progress",
        );
      });
    },
  });

  clearTimeout(timer);

  if (result.status === "waiting") {
    run.set("status", "waiting");
    run.set("state", result.state);
    // Release the lock — the resume may well happen in a different process.
    run.set("lockedBy", undefined);
    run.set("lockedAt", undefined);
    await run.save();
    return { status: "waiting", resumeAt: result.resumeAt, webhookResponse };
  }

  if (result.status === "error") {
    await finishRun(run, "error", result.error);
    await bumpStats(String(workflow._id), false);

    // Fire and forget — alerting must never delay or fail the run itself.
    void handleRunFailure({
      workflowId: String(workflow._id),
      workflowName: String(workflow.name),
      runId: String(run._id),
      error: result.error,
      errorNodeId: result.nodeId,
      mode: String(run.mode ?? "manual"),
    });

    return {
      status: "error",
      error: result.error,
      errorNodeId: result.nodeId,
      webhookResponse,
    };
  }

  await finishRun(run, "success");
  await bumpStats(String(workflow._id), true);
  return { status: "success", lastOutput: result.lastOutput, webhookResponse };
}

/**
 * Mongoose's DocumentArray typing does not accept our plain step objects, and
 * casting at every call site is noisy — this keeps it in one place.
 */
function pushStep(run: RunDoc, step: RunStepRecord): void {
  (run.steps as unknown as RunStepRecord[]).push(step);
}

async function finishRun(
  run: RunDoc,
  status: "success" | "error",
  error?: string,
): Promise<void> {
  const finishedAt = new Date();
  run.set("status", status);
  run.set("error", error);
  run.set("finishedAt", finishedAt);
  run.set(
    "durationMs",
    run.startedAt ? finishedAt.getTime() - run.startedAt.getTime() : 0,
  );
  run.set("state", undefined);
  // Release the lock so the terminal status is the only thing guarding re-entry.
  run.set("lockedBy", undefined);
  run.set("lockedAt", undefined);
  run.set("expiresAt", runExpiryDate());
  await run.save();
}

async function bumpStats(workflowId: string, ok: boolean): Promise<void> {
  await Workflow.updateOne(
    { _id: workflowId },
    {
      $inc: {
        "stats.runs": 1,
        ...(ok ? { "stats.success": 1 } : { "stats.errors": 1 }),
      },
      $set: {
        "stats.lastRunAt": new Date(),
        "stats.lastRunStatus": ok ? "success" : "error",
      },
    },
  ).catch(() => undefined);
}
