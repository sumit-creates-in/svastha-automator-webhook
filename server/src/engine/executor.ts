import { Types } from 'mongoose';
import { env } from '../config/env';
import { decryptJson } from '../lib/crypto';
import { toErrorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { Connection } from '../models/Connection';
import { Run, runExpiryDate, type RunDoc } from '../models/Run';
import { Workflow } from '../models/Workflow';
import { resolveValue } from './expression';
import { getNodeDefinition, requireNodeDefinition } from './registry';
import type {
  ExpressionScope,
  NodeExecutionContext,
  NodeExecutionResult,
  RunState,
  RunStepRecord,
  WorkflowEdge,
  WorkflowNode,
} from './types';

/** Safety net against a workflow that loops forever. */
const MAX_STEPS_PER_RUN = 500;

export interface WebhookResponsePayload {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  hasBody: boolean;
}

export interface ExecuteResult {
  status: 'success' | 'error' | 'waiting' | 'cancelled';
  error?: string;
  resumeAt?: Date;
  lastOutput?: unknown;
  webhookResponse?: WebhookResponsePayload;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
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
    if (!Types.ObjectId.isValid(id)) throw new Error(`Invalid connection id "${id}"`);

    const connection = await Connection.findById(id).select('+data').lean();
    if (!connection) throw new Error('The selected connection no longer exists');

    const config = decryptJson<Record<string, unknown>>(connection.data as string);
    cache.set(id, config);
    return config;
  };
}

function buildScope(
  state: RunState,
  input: Record<string, unknown>,
  trigger: Record<string, unknown>,
  variables: Record<string, unknown>,
  runId: string,
  workflowId: string,
  workflowName: string,
): ExpressionScope {
  const nodeScope: Record<string, { json: unknown }> = {};
  for (const [name, id] of Object.entries(state.nodeNameToId)) {
    nodeScope[name] = { json: state.nodeOutputs[id] ?? null };
  }

  return {
    $json: input,
    $trigger: trigger,
    $node: nodeScope,
    $vars: variables,
    $runId: runId,
    $workflowId: workflowId,
    $workflowName: workflowName,
    $now: new Date().toISOString(),
    $timestamp: Date.now(),
  };
}

/** Resolves node params, skipping properties flagged `resolveExpressions: false`. */
function resolveParams(node: WorkflowNode, scope: ExpressionScope): Record<string, unknown> {
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

function downstream(edges: WorkflowEdge[], nodeId: string, handles: string[]): WorkflowEdge[] {
  return edges.filter(
    (edge) => edge.source === nodeId && handles.includes(edge.sourceHandle ?? 'main'),
  );
}

/**
 * Executes (or resumes) a single run. Returns without throwing — the outcome is
 * always reported through ExecuteResult so the worker can update the job.
 */
export async function executeRun(runId: string): Promise<ExecuteResult> {
  const run = await Run.findById(runId).select('+state');
  if (!run) return { status: 'error', error: 'Run not found' };

  const workflow = await Workflow.findById(run.workflow).lean();
  if (!workflow) {
    run.status = 'error';
    run.error = 'Workflow was deleted';
    run.finishedAt = new Date();
    await run.save();
    return { status: 'error', error: 'Workflow was deleted' };
  }

  const nodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
  const edges = (workflow.edges ?? []) as unknown as WorkflowEdge[];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const controller = new AbortController();
  const timeoutMs = Number(workflow.settings?.timeoutMs ?? env.engine.runTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const getConnection = makeConnectionResolver();
  const triggerPayload = asRecord(run.trigger?.payload ?? {});
  const variables = asRecord(workflow.variables ?? {});

  // Resume from saved state, or start fresh from the trigger node.
  let state: RunState = (run.get('state') as RunState | undefined) ?? {
    nodeOutputs: {},
    nodeNameToId: Object.fromEntries(nodes.map((node) => [node.name, node.id])),
    queue: [],
    executed: [],
  };

  if (state.queue.length === 0 && state.executed.length === 0) {
    const triggerNode = nodes.find((node) => node.id === run.trigger?.nodeId);
    if (!triggerNode) {
      clearTimeout(timer);
      const error = 'Trigger node not found in this workflow';
      await finishRun(run, 'error', error);
      return { status: 'error', error };
    }
    state.nodeOutputs[triggerNode.id] = triggerPayload;
    state.executed.push(triggerNode.id);
    for (const edge of downstream(edges, triggerNode.id, ['main'])) {
      state.queue.push({ nodeId: edge.target, input: triggerPayload });
    }
    run.steps.push({
      nodeId: triggerNode.id,
      nodeName: triggerNode.name,
      nodeType: triggerNode.type,
      status: 'success',
      output: triggerPayload,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 0,
      tries: 1,
    } as RunStepRecord);
  }

  run.status = 'running';
  if (!run.startedAt) run.startedAt = new Date();
  await run.save();

  let webhookResponse: WebhookResponsePayload | undefined;
  let lastOutput: unknown = triggerPayload;
  let stepCount = state.executed.length;

  try {
    while (state.queue.length > 0) {
      if (controller.signal.aborted || Date.now() > deadline) {
        throw new Error(`Run exceeded the ${timeoutMs}ms time limit`);
      }
      if (++stepCount > MAX_STEPS_PER_RUN) {
        throw new Error(
          `Run exceeded ${MAX_STEPS_PER_RUN} steps — check for a loop in the workflow`,
        );
      }

      const item = state.queue.shift();
      if (!item) break;

      const node = nodeById.get(item.nodeId);
      if (!node) continue;

      if (node.disabled) {
        // Skip but keep the chain alive.
        for (const edge of downstream(edges, node.id, ['main'])) {
          state.queue.push({ nodeId: edge.target, input: item.input });
        }
        run.steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'skipped',
          startedAt: new Date(),
          finishedAt: new Date(),
          durationMs: 0,
        } as RunStepRecord);
        continue;
      }

      const definition = requireNodeDefinition(node.type);
      if (!definition.execute) {
        throw new Error(`Node "${node.name}" (${node.type}) cannot be executed here`);
      }

      const scope = buildScope(
        state,
        item.input,
        triggerPayload,
        variables,
        String(run._id),
        String(workflow._id),
        String(workflow.name),
      );

      const logs: string[] = [];
      const startedAt = new Date();
      const maxTries = node.retryOnFail ? Math.max(1, Number(node.maxTries ?? 3)) : 1;

      let result: NodeExecutionResult | undefined;
      let lastError: unknown;
      let tries = 0;

      while (tries < maxTries) {
        tries += 1;
        try {
          const params = resolveParams(node, scope);
          const ctx: NodeExecutionContext = {
            node,
            params,
            rawParams: node.params ?? {},
            input: item.input,
            scope,
            runId: String(run._id),
            workflowId: String(workflow._id),
            getConnection,
            resolve: (value) => resolveValue(value, scope),
            log: (message) => logs.push(`${new Date().toISOString()}  ${message}`),
            signal: controller.signal,
          };
          result = await definition.execute(ctx);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (tries < maxTries) {
            await sleep(Number(node.waitBetweenTriesMs ?? 1000), controller.signal);
          }
        }
      }

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      if (lastError || !result) {
        const message = toErrorMessage(lastError ?? new Error('Node returned no result'));
        run.steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'error',
          input: item.input,
          error: message,
          logs,
          startedAt,
          finishedAt,
          durationMs,
          tries,
        } as RunStepRecord);

        if (node.onError === 'continue') {
          const errorPayload = { error: message, __failed: true, input: item.input };
          state.nodeOutputs[node.id] = errorPayload;
          state.executed.push(node.id);
          for (const edge of downstream(edges, node.id, ['main'])) {
            state.queue.push({ nodeId: edge.target, input: errorPayload });
          }
          await run.save();
          continue;
        }

        throw new Error(`${node.name}: ${message}`);
      }

      if (result.kind === 'wait') {
        // Persist and hand control back to the queue; resume after resumeAt.
        state.queue.unshift(...downstreamQueue(edges, node.id, result.data));
        state.nodeOutputs[node.id] = result.data;
        state.executed.push(node.id);
        run.steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'waiting',
          input: item.input,
          output: { resumeAt: result.resumeAt },
          logs,
          startedAt,
          finishedAt,
          durationMs,
          tries,
        } as RunStepRecord);

        const waitMs = result.resumeAt.getTime() - Date.now();
        if (waitMs <= env.engine.inlineDelayMs) {
          await sleep(Math.max(0, waitMs), controller.signal);
          continue;
        }

        run.status = 'waiting';
        run.set('state', state);
        await run.save();
        clearTimeout(timer);
        return { status: 'waiting', resumeAt: result.resumeAt };
      }

      if (result.kind === 'stop') {
        run.steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          status: 'stopped',
          input: item.input,
          output: result.data,
          error: result.reason,
          logs,
          startedAt,
          finishedAt,
          durationMs,
          tries,
        } as RunStepRecord);
        state.executed.push(node.id);
        await run.save();
        continue;
      }

      // Normal output.
      state.nodeOutputs[node.id] = result.data;
      state.executed.push(node.id);
      lastOutput = result.data;

      const responseMeta = (result.data as Record<string, unknown>).__webhookResponse;
      if (responseMeta) webhookResponse = responseMeta as unknown as WebhookResponsePayload;

      run.steps.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'success',
        input: item.input,
        output: result.data,
        logs,
        startedAt,
        finishedAt,
        durationMs,
        tries,
      } as RunStepRecord);

      const handles = result.outputs ?? ['main'];
      for (const edge of downstream(edges, node.id, handles)) {
        state.queue.push({ nodeId: edge.target, input: result.data });
      }

      await run.save();
    }

    clearTimeout(timer);
    await finishRun(run, 'success');
    await bumpStats(String(workflow._id), true);
    return { status: 'success', lastOutput, webhookResponse };
  } catch (error) {
    clearTimeout(timer);
    const message = toErrorMessage(error);
    logger.warn({ runId, err: message }, 'Run failed');
    await finishRun(run, 'error', message);
    await bumpStats(String(workflow._id), false);
    return { status: 'error', error: message, webhookResponse };
  }
}

function downstreamQueue(
  edges: WorkflowEdge[],
  nodeId: string,
  data: Record<string, unknown>,
): Array<{ nodeId: string; input: Record<string, unknown> }> {
  return downstream(edges, nodeId, ['main']).map((edge) => ({ nodeId: edge.target, input: data }));
}

async function finishRun(
  run: RunDoc,
  status: 'success' | 'error',
  error?: string,
): Promise<void> {
  const finishedAt = new Date();
  run.set('status', status);
  run.set('error', error);
  run.set('finishedAt', finishedAt);
  run.set('durationMs', run.startedAt ? finishedAt.getTime() - run.startedAt.getTime() : 0);
  run.set('state', undefined);
  run.set('expiresAt', runExpiryDate());
  await run.save();
}

async function bumpStats(workflowId: string, ok: boolean): Promise<void> {
  await Workflow.updateOne(
    { _id: workflowId },
    {
      $inc: { 'stats.runs': 1, ...(ok ? { 'stats.success': 1 } : { 'stats.errors': 1 }) },
      $set: { 'stats.lastRunAt': new Date(), 'stats.lastRunStatus': ok ? 'success' : 'error' },
    },
  ).catch(() => undefined);
}
