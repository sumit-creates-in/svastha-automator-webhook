/**
 * Pure graph traversal for the SVASTHA Automator engine.
 *
 * This module deliberately knows nothing about MongoDB, Express or node
 * implementations — it receives a graph plus an `execute` callback and walks it.
 * That makes the exact logic that runs in production fully unit-testable, which
 * is how branching, joins and loops are verified in `graph.test.ts`.
 *
 * Semantics
 * ---------
 * - **Fan-out.** Every edge leaving an executed output handle is followed. A node
 *   with three actions attached runs all three, independently.
 * - **Fan-in.** If several branches point at an ordinary node, that node runs once
 *   per arrival. Only nodes that declare `inputs > 1` (the Merge node) wait and
 *   combine.
 * - **Barriers.** Work that must happen "after everything else" — a Merge waiting
 *   for a slow branch, a Loop's `done` output — is parked and released when the
 *   ready queue drains. This is deadlock-free by construction: a barrier can only
 *   be released when nothing else can run.
 * - **Resumability.** The whole traversal state is plain JSON, so a run paused by
 *   a Wait step can continue in a different process days later.
 */

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  /** Number of input handles. Anything above 1 makes the node a join point. */
  inputs: number;
  disabled?: boolean;
  onError?: 'stop' | 'continue';
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface QueueItem {
  nodeId: string;
  input: Record<string, unknown>;
  /** Which target handle the data arrived on (used by Merge). */
  handle?: string;
  /** Populated when a join barrier releases: one entry per branch that arrived. */
  arrivals?: Array<{ handle: string; data: Record<string, unknown> }>;
  /** Index and total when this item came from a Loop fan-out. */
  loop?: { index: number; total: number; nodeId: string };
}

export type PendingBarrier =
  | {
      type: 'join';
      nodeId: string;
      arrivals: Array<{ handle: string; data: Record<string, unknown> }>;
    }
  | {
      type: 'loopDone';
      nodeId: string;
      data: Record<string, unknown>;
    };

/** Everything needed to pause a run and pick it up later. */
export interface TraversalState {
  queue: QueueItem[];
  barriers: PendingBarrier[];
  nodeOutputs: Record<string, unknown>;
  executed: string[];
  stepCount: number;
}

export type StepOutcome =
  | { kind: 'output'; data: Record<string, unknown>; outputs?: string[] }
  | { kind: 'stop'; data?: Record<string, unknown>; reason?: string }
  | { kind: 'wait'; resumeAt: Date; data: Record<string, unknown> }
  | {
      /** Loop Over Items: run the `handle` branch once per element. */
      kind: 'fanOut';
      items: Array<Record<string, unknown>>;
      handle: string;
      doneData?: Record<string, unknown>;
    };

export interface StepRecord {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped' | 'stopped' | 'waiting';
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

export interface RunGraphOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Trigger node id — only used when starting a fresh run. */
  startNodeId?: string;
  startData?: Record<string, unknown>;
  /** Provide to resume a paused run instead of starting from the trigger. */
  state?: TraversalState;
  execute: (node: GraphNode, item: QueueItem) => Promise<StepOutcome>;
  /** Called for every step, including skips and failures. */
  onStep?: (record: StepRecord) => void | Promise<void>;
  /** Called after a node succeeds, before its downstream edges are followed. */
  onOutput?: (node: GraphNode, data: Record<string, unknown>) => void | Promise<void>;
  maxSteps?: number;
  /** Return true to abort with a timeout error. */
  isCancelled?: () => boolean;
  cancelMessage?: string;
}

export type RunGraphResult =
  | { status: 'success'; state: TraversalState; lastOutput: Record<string, unknown> }
  | { status: 'error'; state: TraversalState; error: string; nodeId?: string }
  | { status: 'waiting'; state: TraversalState; resumeAt: Date };

export const DEFAULT_MAX_STEPS = 1000;

/** Edges leaving `nodeId` through any of the given output handles. */
export function outgoingEdges(
  edges: GraphEdge[],
  nodeId: string,
  handles: string[],
): GraphEdge[] {
  return edges.filter(
    (edge) => edge.source === nodeId && handles.includes(edge.sourceHandle ?? 'main'),
  );
}

/** How many edges point at `nodeId`. */
export function inboundEdges(edges: GraphEdge[], nodeId: string): GraphEdge[] {
  return edges.filter((edge) => edge.target === nodeId);
}

export function createInitialState(): TraversalState {
  return { queue: [], barriers: [], nodeOutputs: {}, executed: [], stepCount: 0 };
}

function isJoin(node: GraphNode | undefined): boolean {
  return Boolean(node && node.inputs > 1);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Queues every node downstream of `nodeId` on the given handles.
 *
 * This is the heart of branching: it does not stop at the first match, and it
 * does not care whether the targets are already queued. Three edges out means
 * three queued items.
 */
function dispatch(
  state: TraversalState,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  nodeId: string,
  handles: string[],
  data: Record<string, unknown>,
  loop?: QueueItem['loop'],
): void {
  for (const edge of outgoingEdges(edges, nodeId, handles)) {
    const target = nodes.get(edge.target);
    const handle = edge.targetHandle ?? 'main';

    if (isJoin(target)) {
      // Buffer the arrival; the Merge runs once its branches have all reported,
      // or when nothing else is left to do.
      let barrier = state.barriers.find(
        (entry): entry is Extract<PendingBarrier, { type: 'join' }> =>
          entry.type === 'join' && entry.nodeId === edge.target,
      );
      if (!barrier) {
        barrier = { type: 'join', nodeId: edge.target, arrivals: [] };
        state.barriers.push(barrier);
      }
      barrier.arrivals.push({ handle, data });

      const expected = inboundEdges(edges, edge.target).length;
      if (barrier.arrivals.length >= expected) {
        state.barriers = state.barriers.filter((entry) => entry !== barrier);
        state.queue.push({
          nodeId: edge.target,
          input: barrier.arrivals[0]?.data ?? {},
          arrivals: barrier.arrivals,
          loop,
        });
      }
      continue;
    }

    state.queue.push({ nodeId: edge.target, input: data, handle, loop });
  }
}

/** Moves one parked barrier back into the ready queue. Returns false when none are left. */
function releaseBarrier(
  state: TraversalState,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): boolean {
  const barrier = state.barriers.shift();
  if (!barrier) return false;

  if (barrier.type === 'join') {
    state.queue.push({
      nodeId: barrier.nodeId,
      input: barrier.arrivals[0]?.data ?? {},
      arrivals: barrier.arrivals,
    });
    return true;
  }

  // Loop finished: continue from its `done` output.
  dispatch(state, nodes, edges, barrier.nodeId, ['done'], barrier.data);
  return true;
}

/**
 * Walks the graph until it completes, fails, or hits a Wait step.
 *
 * Never throws: failures are reported through the result so the caller can
 * record them and decide what to do.
 */
export async function runGraph(options: RunGraphOptions): Promise<RunGraphResult> {
  const {
    nodes: nodeList,
    edges,
    execute,
    onStep,
    onOutput,
    maxSteps = DEFAULT_MAX_STEPS,
    isCancelled,
    cancelMessage = 'Run exceeded its time limit',
  } = options;

  const nodes = new Map(nodeList.map((node) => [node.id, node]));
  const state: TraversalState = options.state ?? createInitialState();

  // Fresh run: seed the queue from the trigger's outgoing edges. A state that
  // still has nothing queued and nothing executed counts as fresh, so callers
  // may always pass a state object and let this decide.
  const isFresh = state.queue.length === 0 && state.executed.length === 0 && state.barriers.length === 0;
  if (isFresh && options.startNodeId) {
    const trigger = nodes.get(options.startNodeId);
    if (!trigger) {
      return { status: 'error', state, error: 'Trigger node not found in this workflow' };
    }
    const startData = options.startData ?? {};
    state.nodeOutputs[trigger.id] = startData;
    state.executed.push(trigger.id);
    dispatch(state, nodes, edges, trigger.id, ['main'], startData);
  }

  let lastOutput: Record<string, unknown> = options.startData ?? {};

  for (;;) {
    if (state.queue.length === 0 && !releaseBarrier(state, nodes, edges)) break;
    if (state.queue.length === 0) continue;

    if (isCancelled?.()) {
      return { status: 'error', state, error: cancelMessage };
    }

    state.stepCount += 1;
    if (state.stepCount > maxSteps) {
      return {
        status: 'error',
        state,
        error: `Run exceeded ${maxSteps} steps — check for a loop in the workflow`,
      };
    }

    const item = state.queue.shift();
    if (!item) continue;

    const node = nodes.get(item.nodeId);
    if (!node) continue;

    const startedAt = new Date();

    // A disabled step is transparent: skip it but keep the chain alive.
    if (node.disabled) {
      await onStep?.({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'skipped',
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
      });
      dispatch(state, nodes, edges, node.id, ['main'], item.input, item.loop);
      continue;
    }

    let outcome: StepOutcome;
    try {
      outcome = await execute(node, item);
    } catch (error) {
      const message = errorMessage(error);
      const finishedAt = new Date();
      await onStep?.({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'error',
        input: item.input,
        error: message,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });

      if (node.onError === 'continue') {
        const payload = { error: message, __failed: true, input: item.input };
        state.nodeOutputs[node.id] = payload;
        state.executed.push(node.id);
        dispatch(state, nodes, edges, node.id, ['main'], payload, item.loop);
        continue;
      }

      return { status: 'error', state, error: `${node.name}: ${message}`, nodeId: node.id };
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    if (outcome.kind === 'wait') {
      // Park the continuation, then persist and hand back control.
      state.nodeOutputs[node.id] = outcome.data;
      state.executed.push(node.id);
      dispatch(state, nodes, edges, node.id, ['main'], outcome.data, item.loop);
      await onStep?.({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'waiting',
        input: item.input,
        output: { resumeAt: outcome.resumeAt },
        startedAt,
        finishedAt,
        durationMs,
      });
      return { status: 'waiting', state, resumeAt: outcome.resumeAt };
    }

    if (outcome.kind === 'stop') {
      state.executed.push(node.id);
      await onStep?.({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'stopped',
        input: item.input,
        output: outcome.data,
        error: outcome.reason,
        startedAt,
        finishedAt,
        durationMs,
      });
      continue;
    }

    if (outcome.kind === 'fanOut') {
      const summary = {
        itemCount: outcome.items.length,
        ...(outcome.doneData ?? {}),
      };
      state.nodeOutputs[node.id] = summary;
      state.executed.push(node.id);

      await onStep?.({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        status: 'success',
        input: item.input,
        output: summary,
        startedAt,
        finishedAt,
        durationMs,
      });

      outcome.items.forEach((element, index) => {
        dispatch(state, nodes, edges, node.id, [outcome.handle], element, {
          index,
          total: outcome.items.length,
          nodeId: node.id,
        });
      });

      // `done` fires once every iteration has been processed.
      if (outgoingEdges(edges, node.id, ['done']).length > 0) {
        state.barriers.push({ type: 'loopDone', nodeId: node.id, data: summary });
      }
      continue;
    }

    // Ordinary success.
    state.nodeOutputs[node.id] = outcome.data;
    state.executed.push(node.id);
    lastOutput = outcome.data;

    await onOutput?.(node, outcome.data);
    await onStep?.({
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      status: 'success',
      input: item.input,
      output: outcome.data,
      startedAt,
      finishedAt,
      durationMs,
    });

    dispatch(state, nodes, edges, node.id, outcome.outputs ?? ['main'], outcome.data, item.loop);
  }

  return { status: 'success', state, lastOutput };
}
