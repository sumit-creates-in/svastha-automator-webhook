/**
 * Graph traversal tests.
 *
 * These cover the behaviour that was reported broken: a trigger wired to several
 * actions must run all of them. They also lock down joins, loops, disabled steps,
 * error policies and resumability so the same class of bug cannot come back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInitialState,
  inboundEdges,
  outgoingEdges,
  runGraph,
  type GraphEdge,
  type GraphNode,
  type StepOutcome,
  type StepRecord,
} from './graph';

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type: 'test', name: id, inputs: 1, ...extra };
}

function edge(source: string, target: string, sourceHandle = 'main', targetHandle = 'main'): GraphEdge {
  return { id: `${source}->${target}:${sourceHandle}`, source, target, sourceHandle, targetHandle };
}

/** Records execution order and lets individual nodes behave differently. */
function recorder(behaviour: Record<string, (input: Record<string, unknown>) => StepOutcome> = {}) {
  const order: string[] = [];
  const steps: StepRecord[] = [];
  const execute = async (n: GraphNode, item: { input: Record<string, unknown> }) => {
    order.push(n.id);
    const custom = behaviour[n.id];
    if (custom) return custom(item.input);
    return { kind: 'output', data: { ...item.input, [`${n.id}_ran`]: true } } as StepOutcome;
  };
  return { order, steps, execute, onStep: (record: StepRecord) => void steps.push(record) };
}

test('a trigger wired to three actions runs all three', async () => {
  const { order, execute } = recorder();

  const result = await runGraph({
    nodes: [node('trigger'), node('http'), node('email'), node('sheet')],
    edges: [edge('trigger', 'http'), edge('trigger', 'email'), edge('trigger', 'sheet')],
    startNodeId: 'trigger',
    startData: { name: 'Sumit' },
    execute,
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(order.sort(), ['email', 'http', 'sheet']);
});

test('every branch receives the same trigger data independently', async () => {
  const seen: Record<string, unknown> = {};
  const result = await runGraph({
    nodes: [node('trigger'), node('a'), node('b')],
    edges: [edge('trigger', 'a'), edge('trigger', 'b')],
    startNodeId: 'trigger',
    startData: { email: 'test@example.com' },
    execute: async (n, item) => {
      seen[n.id] = item.input;
      return { kind: 'output', data: { ok: n.id } };
    },
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(seen.a, { email: 'test@example.com' });
  assert.deepEqual(seen.b, { email: 'test@example.com' });
});

test('branching survives several levels deep', async () => {
  const { order, execute } = recorder();

  await runGraph({
    nodes: ['trigger', 'a', 'b', 'a1', 'a2', 'b1'].map((id) => node(id)),
    edges: [
      edge('trigger', 'a'),
      edge('trigger', 'b'),
      edge('a', 'a1'),
      edge('a', 'a2'),
      edge('b', 'b1'),
    ],
    startNodeId: 'trigger',
    execute,
  });

  assert.deepEqual(order.sort(), ['a', 'a1', 'a2', 'b', 'b1']);
});

test('one failing branch does not silently cancel the others when set to continue', async () => {
  const { order, execute } = recorder({
    bad: () => {
      throw new Error('upstream exploded');
    },
  });

  const result = await runGraph({
    nodes: [node('trigger'), node('bad', { onError: 'continue' }), node('good'), node('after')],
    edges: [edge('trigger', 'bad'), edge('trigger', 'good'), edge('bad', 'after')],
    startNodeId: 'trigger',
    execute,
  });

  assert.equal(result.status, 'success');
  assert.ok(order.includes('good'));
  assert.ok(order.includes('after'), 'continue-on-error should still follow the chain');
});

test('a failing step with the default policy stops the run and names the node', async () => {
  const result = await runGraph({
    nodes: [node('trigger'), node('bad')],
    edges: [edge('trigger', 'bad')],
    startNodeId: 'trigger',
    execute: async () => {
      throw new Error('SMTP refused the connection');
    },
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.match(result.error, /bad: SMTP refused the connection/);
    assert.equal(result.nodeId, 'bad');
  }
});

test('an ordinary node fed by two branches runs once per arrival', async () => {
  const { order, execute } = recorder();

  await runGraph({
    nodes: [node('trigger'), node('a'), node('b'), node('notify')],
    edges: [edge('trigger', 'a'), edge('trigger', 'b'), edge('a', 'notify'), edge('b', 'notify')],
    startNodeId: 'trigger',
    execute,
  });

  assert.equal(order.filter((id) => id === 'notify').length, 2);
});

test('a Merge node waits for both branches and runs once', async () => {
  const { order, execute } = recorder();
  let arrivals: unknown;

  await runGraph({
    nodes: [node('trigger'), node('a'), node('b'), node('merge', { inputs: 2 })],
    edges: [
      edge('trigger', 'a'),
      edge('trigger', 'b'),
      edge('a', 'merge', 'main', 'input1'),
      edge('b', 'merge', 'main', 'input2'),
    ],
    startNodeId: 'trigger',
    execute: async (n, item) => {
      order.push(n.id);
      if (n.id === 'merge') arrivals = item.arrivals;
      return { kind: 'output', data: { ran: n.id } };
    },
  });

  assert.equal(order.filter((id) => id === 'merge').length, 1, 'merge must run exactly once');
  assert.equal(Array.isArray(arrivals) && arrivals.length, 2);
});

test('a Merge still fires when one branch was filtered away', async () => {
  const { order } = recorder();

  const result = await runGraph({
    nodes: [node('trigger'), node('a'), node('b'), node('merge', { inputs: 2 })],
    edges: [
      edge('trigger', 'a'),
      edge('trigger', 'b'),
      edge('a', 'merge', 'main', 'input1'),
      edge('b', 'merge', 'main', 'input2'),
    ],
    startNodeId: 'trigger',
    execute: async (n, item) => {
      order.push(n.id);
      if (n.id === 'b') return { kind: 'stop', reason: 'filtered' };
      return { kind: 'output', data: { ran: n.id, ...item.input } };
    },
  });

  assert.equal(result.status, 'success');
  assert.ok(order.includes('merge'), 'a half-arrived merge must be released, not deadlock');
});

test('If/Else only follows the handle it selected', async () => {
  const { order } = recorder();

  await runGraph({
    nodes: [node('trigger'), node('if'), node('yes'), node('no')],
    edges: [edge('trigger', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false')],
    startNodeId: 'trigger',
    execute: async (n, item) => {
      order.push(n.id);
      if (n.id === 'if') return { kind: 'output', data: item.input, outputs: ['true'] };
      return { kind: 'output', data: {} };
    },
  });

  assert.ok(order.includes('yes'));
  assert.equal(order.includes('no'), false);
});

test('Loop runs its branch once per item and fires done afterwards', async () => {
  const perItem: unknown[] = [];
  const order: string[] = [];

  const result = await runGraph({
    nodes: [node('trigger'), node('loop'), node('row'), node('summary')],
    edges: [edge('trigger', 'loop'), edge('loop', 'row', 'loop'), edge('loop', 'summary', 'done')],
    startNodeId: 'trigger',
    startData: { items: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }] },
    execute: async (n, item) => {
      order.push(n.id);
      if (n.id === 'loop') {
        return {
          kind: 'fanOut',
          handle: 'loop',
          items: (item.input.items as Array<Record<string, unknown>>) ?? [],
        };
      }
      if (n.id === 'row') perItem.push(item.input);
      return { kind: 'output', data: {} };
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(perItem.length, 3);
  assert.deepEqual(perItem, [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
  assert.equal(order.at(-1), 'summary', 'done must run after every iteration');
});

test('loop iterations know their position', async () => {
  const positions: Array<{ index: number; total: number }> = [];

  await runGraph({
    nodes: [node('trigger'), node('loop'), node('row')],
    edges: [edge('trigger', 'loop'), edge('loop', 'row', 'loop')],
    startNodeId: 'trigger',
    execute: async (n, item) => {
      if (n.id === 'loop') {
        return { kind: 'fanOut', handle: 'loop', items: [{ a: 1 }, { a: 2 }] };
      }
      if (item.loop) positions.push({ index: item.loop.index, total: item.loop.total });
      return { kind: 'output', data: {} };
    },
  });

  assert.deepEqual(positions, [
    { index: 0, total: 2 },
    { index: 1, total: 2 },
  ]);
});

test('a disabled step is skipped but the chain continues', async () => {
  const { order, execute } = recorder();

  await runGraph({
    nodes: [node('trigger'), node('off', { disabled: true }), node('after')],
    edges: [edge('trigger', 'off'), edge('off', 'after')],
    startNodeId: 'trigger',
    execute,
  });

  assert.deepEqual(order, ['after']);
});

test('a Wait step pauses and the resumed run finishes the remaining branches', async () => {
  const order: string[] = [];
  const nodes = [node('trigger'), node('wait'), node('a'), node('b')];
  const edges = [edge('trigger', 'wait'), edge('wait', 'a'), edge('trigger', 'b')];

  const execute = async (n: GraphNode, item: { input: Record<string, unknown> }) => {
    order.push(n.id);
    if (n.id === 'wait') {
      return { kind: 'wait', resumeAt: new Date(Date.now() + 60_000), data: item.input } as StepOutcome;
    }
    return { kind: 'output', data: {} } as StepOutcome;
  };

  const paused = await runGraph({ nodes, edges, startNodeId: 'trigger', execute });
  assert.equal(paused.status, 'waiting');

  // The state must survive a JSON round-trip — it is stored in MongoDB.
  const revived = JSON.parse(JSON.stringify(paused.state));
  const resumed = await runGraph({ nodes, edges, state: revived, execute });

  assert.equal(resumed.status, 'success');
  assert.ok(order.includes('a'), 'the branch after the wait must run on resume');
  assert.ok(order.includes('b'), 'the parallel branch must not be lost');
});

test('a run interrupted mid-way resumes without replaying finished steps', async () => {
  // Reproduces the container-restart duplication: the process dies after the
  // HTTP step, the job is reclaimed, and the run continues. The webhook must NOT
  // be sent twice and the sheet row must NOT be written twice.
  const calls: string[] = [];
  const nodes = [node('trigger'), node('http'), node('sheet'), node('email')];
  const edges = [edge('trigger', 'http'), edge('http', 'sheet'), edge('sheet', 'email')];

  let killAfter = 'sheet';
  const execute = async (n: GraphNode) => {
    calls.push(n.id);
    if (n.id === killAfter) throw new Error('__container_died__');
    return { kind: 'output', data: { ok: n.id } } as StepOutcome;
  };

  // First attempt: trigger → http → sheet (dies).
  const first = await runGraph({ nodes, edges, startNodeId: 'trigger', execute });
  assert.equal(first.status, 'error');
  assert.deepEqual(calls, ['http', 'sheet']);

  // The state is what would have been persisted before the crash.
  const persisted = JSON.parse(JSON.stringify(first.state));

  killAfter = 'none';
  calls.length = 0;
  const second = await runGraph({ nodes, edges, state: persisted, execute });

  assert.equal(second.status, 'success');
  assert.equal(
    calls.filter((id) => id === 'http').length,
    0,
    'the HTTP step already ran — it must not be sent again',
  );
});

test('resuming from persisted state never re-seeds from the trigger', async () => {
  const calls: string[] = [];
  const nodes = [node('trigger'), node('a'), node('b')];
  const edges = [edge('trigger', 'a'), edge('a', 'b')];

  const first = await runGraph({
    nodes,
    edges,
    startNodeId: 'trigger',
    execute: async (n) => {
      calls.push(n.id);
      if (n.id === 'a') {
        return { kind: 'wait', resumeAt: new Date(Date.now() + 1000), data: {} } as StepOutcome;
      }
      return { kind: 'output', data: {} } as StepOutcome;
    },
  });
  assert.equal(first.status, 'waiting');

  calls.length = 0;
  // startNodeId is still supplied, exactly as the executor does on resume.
  const resumed = await runGraph({
    nodes,
    edges,
    startNodeId: 'trigger',
    state: JSON.parse(JSON.stringify(first.state)),
    execute: async (n) => {
      calls.push(n.id);
      return { kind: 'output', data: {} } as StepOutcome;
    },
  });

  assert.equal(resumed.status, 'success');
  assert.deepEqual(calls, ['b'], 'only the outstanding step should run');
});

test('runaway graphs are stopped by the step ceiling', async () => {
  const result = await runGraph({
    nodes: [node('trigger'), node('a'), node('b')],
    edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'a')],
    startNodeId: 'trigger',
    maxSteps: 25,
    execute: async () => ({ kind: 'output', data: {} }),
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /exceeded 25 steps/);
});

test('cancellation is reported as an error, not a success', async () => {
  let calls = 0;
  const result = await runGraph({
    nodes: [node('trigger'), node('a'), node('b')],
    edges: [edge('trigger', 'a'), edge('a', 'b')],
    startNodeId: 'trigger',
    isCancelled: () => ++calls > 1,
    cancelMessage: 'Run exceeded the 300000ms time limit',
    execute: async () => ({ kind: 'output', data: {} }),
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /time limit/);
});

test('a missing trigger fails cleanly', async () => {
  const result = await runGraph({
    nodes: [node('a')],
    edges: [],
    startNodeId: 'ghost',
    execute: async () => ({ kind: 'output', data: {} }),
  });
  assert.equal(result.status, 'error');
});

test('a trigger with nothing attached succeeds without doing anything', async () => {
  const result = await runGraph({
    nodes: [node('trigger')],
    edges: [],
    startNodeId: 'trigger',
    startData: { a: 1 },
    execute: async () => ({ kind: 'output', data: {} }),
  });
  assert.equal(result.status, 'success');
});

test('edge helpers respect handles', () => {
  const edges = [edge('a', 'b', 'true'), edge('a', 'c', 'false'), edge('a', 'd')];
  assert.equal(outgoingEdges(edges, 'a', ['true']).length, 1);
  assert.equal(outgoingEdges(edges, 'a', ['true', 'false']).length, 2);
  assert.equal(outgoingEdges(edges, 'a', ['main']).length, 1);
  assert.equal(inboundEdges(edges, 'b').length, 1);
});

test('a fresh state object is empty and serialisable', () => {
  const state = createInitialState();
  assert.deepEqual(state.queue, []);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
