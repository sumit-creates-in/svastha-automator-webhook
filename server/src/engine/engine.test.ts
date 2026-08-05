/**
 * Engine unit tests — no database required.
 * Run with:  npm test --prefix server
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptJson, encryptJson, hmacSha256Hex, safeCompare } from '../lib/crypto';
import { getPath, resolveValue, setPath } from './expression';
import { evaluateConditions } from './nodes/conditions';
import transform from './nodes/transform';
import ifCondition from './nodes/ifCondition';
import filter from './nodes/filter';
import delay from './nodes/delay';
import code from './nodes/code';
import { buildCronExpression, nextFireTime } from './scheduler';
import { listNodeDefinitions, defaultParamsFor } from './registry';
import type { ExpressionScope, NodeExecutionContext } from './types';

function makeScope(json: Record<string, unknown>): ExpressionScope {
  return {
    $json: json,
    $trigger: json,
    $node: { 'Step A': { json: { id: 42, tags: ['a', 'b'] } } },
    $vars: { region: 'IN' },
    $runId: 'run_1',
    $workflowId: 'wf_1',
    $workflowName: 'Test workflow',
    $now: new Date('2026-08-05T10:00:00Z').toISOString(),
    $timestamp: Date.parse('2026-08-05T10:00:00Z'),
  };
}

function makeCtx(
  params: Record<string, unknown>,
  input: Record<string, unknown>,
): NodeExecutionContext {
  const scope = makeScope(input);
  return {
    node: { id: 'n1', type: 'x', name: 'Step', position: { x: 0, y: 0 }, params },
    params: resolveValue(params, scope),
    rawParams: params,
    input,
    scope,
    runId: 'run_1',
    workflowId: 'wf_1',
    getConnection: async () => ({}),
    resolve: (value) => resolveValue(value, scope),
    log: () => undefined,
    signal: new AbortController().signal,
  };
}

test('expressions: single expression keeps its native type', () => {
  const scope = makeScope({ count: 7, active: true, user: { name: 'Sumit' } });
  assert.equal(resolveValue('{{ $json.count }}', scope), 7);
  assert.equal(resolveValue('{{ $json.active }}', scope), true);
  assert.deepEqual(resolveValue('{{ $json.user }}', scope), { name: 'Sumit' });
});

test('expressions: interpolation inside a sentence', () => {
  const scope = makeScope({ name: 'Sumit', city: 'Pune' });
  assert.equal(resolveValue('Hi {{ $json.name }} from {{ $json.city }}!', scope), 'Hi Sumit from Pune!');
});

test('expressions: helper functions and earlier node output', () => {
  const scope = makeScope({ email: '  Test@Example.COM ' });
  assert.equal(resolveValue('{{ $fn.lower($fn.trim($json.email)) }}', scope), 'test@example.com');
  assert.equal(resolveValue('{{ $node["Step A"].json.id }}', scope), 42);
  assert.equal(resolveValue('{{ $vars.region }}', scope), 'IN');
});

test('expressions: missing fields resolve to empty, never throw', () => {
  const scope = makeScope({});
  assert.equal(resolveValue('{{ $json.nope.deeper }}', scope), undefined);
  assert.equal(resolveValue('value: {{ $json.missing }}', scope), 'value: ');
});

test('expressions: sandbox blocks process and require', () => {
  const scope = makeScope({});
  assert.equal(resolveValue('{{ process.env.JWT_SECRET }}', scope), undefined);
  assert.equal(resolveValue('{{ require("fs") }}', scope), undefined);
});

test('expressions: nested objects and arrays are resolved deeply', () => {
  const scope = makeScope({ id: 9 });
  const result = resolveValue(
    { a: '{{ $json.id }}', b: ['x', '{{ $json.id }}'], c: { d: 'id-{{ $json.id }}' } },
    scope,
  );
  assert.deepEqual(result, { a: 9, b: ['x', 9], c: { d: 'id-9' } });
});

test('path helpers read and write dotted paths', () => {
  const source = { user: { address: { city: 'Pune' } }, list: [{ id: 1 }] };
  assert.equal(getPath(source, 'user.address.city'), 'Pune');
  assert.equal(getPath(source, 'list[0].id'), 1);
  const target: Record<string, unknown> = {};
  setPath(target, 'a.b.c', 5);
  assert.deepEqual(target, { a: { b: { c: 5 } } });
});

test('conditions: AND / OR combinators', () => {
  const rows = [
    { left: 'paid', operator: 'equals', right: 'PAID' },
    { left: 1200, operator: 'gt', right: 1000 },
  ];
  assert.equal(evaluateConditions(rows, 'all').passed, true);
  assert.equal(
    evaluateConditions([...rows, { left: 'a', operator: 'equals', right: 'b' }], 'all').passed,
    false,
  );
  assert.equal(
    evaluateConditions([{ left: 'a', operator: 'equals', right: 'b' }, rows[0]], 'any').passed,
    true,
  );
});

test('conditions: emptiness, lists and dates', () => {
  assert.equal(evaluateConditions([{ left: '', operator: 'isEmpty' }], 'all').passed, true);
  assert.equal(
    evaluateConditions([{ left: 'in', operator: 'in', right: 'out, in, maybe' }], 'all').passed,
    true,
  );
  assert.equal(
    evaluateConditions(
      [{ left: '2026-01-02', operator: 'dateAfter', right: '2026-01-01' }],
      'all',
    ).passed,
    true,
  );
});

test('Edit Fields node maps and renames data', async () => {
  const ctx = makeCtx(
    {
      mode: 'onlyDefined',
      fields: [
        { name: 'customer.email', value: '{{ $fn.lower($json.Email) }}', type: 'string' },
        { name: 'total', value: '{{ $json.amount }}', type: 'number' },
        { name: 'vip', value: 'true', type: 'boolean' },
      ],
      renames: [],
    },
    { Email: 'A@B.COM', amount: '250.5' },
  );

  const result = await transform.execute!(ctx);
  assert.equal(result.kind, 'output');
  assert.deepEqual(result.kind === 'output' ? result.data : null, {
    customer: { email: 'a@b.com' },
    total: 250.5,
    vip: true,
  });
});

test('If node routes to the true or false handle', async () => {
  const pass = await ifCondition.execute!(
    makeCtx(
      { combinator: 'all', conditions: [{ left: '{{ $json.status }}', operator: 'equals', right: 'paid' }] },
      { status: 'paid' },
    ),
  );
  assert.deepEqual(pass.kind === 'output' ? pass.outputs : null, ['true']);

  const fail = await ifCondition.execute!(
    makeCtx(
      { combinator: 'all', conditions: [{ left: '{{ $json.status }}', operator: 'equals', right: 'paid' }] },
      { status: 'pending' },
    ),
  );
  assert.deepEqual(fail.kind === 'output' ? fail.outputs : null, ['false']);
});

test('Filter node stops the branch when conditions fail', async () => {
  const result = await filter.execute!(
    makeCtx(
      { combinator: 'all', conditions: [{ left: '{{ $json.email }}', operator: 'contains', right: '@' }] },
      { email: 'not-an-email' },
    ),
  );
  assert.equal(result.kind, 'stop');
});

test('Wait node returns a future resume time', async () => {
  const result = await delay.execute!(makeCtx({ mode: 'duration', amount: 2, unit: 'minutes' }, {}));
  assert.equal(result.kind, 'wait');
  if (result.kind === 'wait') {
    const diff = result.resumeAt.getTime() - Date.now();
    assert.ok(diff > 110_000 && diff <= 120_500, `expected ~2 minutes, got ${diff}ms`);
  }
});

test('Code node runs sandboxed JavaScript and returns an object', async () => {
  const result = await code.execute!(
    makeCtx(
      { jsCode: 'const full = `${$json.first} ${$json.last}`; return { full, n: items.n * 2 };' },
      { first: 'Sumit', last: 'K', n: 21 },
    ),
  );
  assert.deepEqual(result.kind === 'output' ? result.data : null, { full: 'Sumit K', n: 42 });
});

test('Code node cannot reach the filesystem or process', async () => {
  await assert.rejects(
    () => code.execute!(makeCtx({ jsCode: 'return require("fs").readdirSync("/");' }, {})),
    /Code node failed/,
  );
  const result = await code.execute!(makeCtx({ jsCode: 'return { p: typeof process };' }, {}));
  assert.deepEqual(result.kind === 'output' ? result.data : null, { p: 'undefined' });
});

test('Code node enforces its timeout', async () => {
  await assert.rejects(
    () => code.execute!(makeCtx({ jsCode: 'while (true) {}' }, {})),
    /Code node failed/,
  );
});

test('schedule builder produces valid cron expressions', () => {
  assert.equal(buildCronExpression({ mode: 'interval', minutes: 10 }), '*/10 * * * *');
  assert.equal(buildCronExpression({ mode: 'daily', minute: 30, hour: 9 }), '30 9 * * *');
  assert.equal(buildCronExpression({ mode: 'weekly', minute: 0, hour: 8, weekday: '1' }), '0 8 * * 1');
  const next = nextFireTime('0 9 * * *', 'Asia/Kolkata', new Date('2026-08-05T00:00:00Z'));
  assert.ok(next.getTime() > Date.parse('2026-08-05T00:00:00Z'));
});

test('credentials round-trip through AES-256-GCM', () => {
  const secret = { host: 'smtp.hostinger.com', password: 'p@ss word', port: 465 };
  const encrypted = encryptJson(secret);
  assert.ok(encrypted.startsWith('v1:'));
  assert.notEqual(encrypted.includes('p@ss word'), true);
  assert.deepEqual(decryptJson(encrypted), secret);

  // Tampering with the ciphertext must fail the GCM authentication tag.
  const parts = encrypted.split(':');
  const flipped = parts[3].startsWith('A') ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
  assert.throws(() => decryptJson([parts[0], parts[1], parts[2], flipped].join(':')));
  assert.throws(() => decryptJson('not-a-payload'));
});

test('constant-time compare and HMAC helpers behave', () => {
  assert.equal(safeCompare('abc', 'abc'), true);
  assert.equal(safeCompare('abc', 'abd'), false);
  assert.equal(safeCompare('abc', 'abcd'), false);
  assert.equal(
    hmacSha256Hex('secret', 'payload'),
    hmacSha256Hex('secret', 'payload'),
  );
});

test('every registered node has the metadata the UI needs', () => {
  const definitions = listNodeDefinitions();
  assert.ok(definitions.length >= 11);
  for (const definition of definitions) {
    assert.ok(definition.type, 'type');
    assert.ok(definition.displayName, `${definition.type} displayName`);
    assert.ok(definition.description.length > 10, `${definition.type} description`);
    assert.ok(definition.outputs.length > 0, `${definition.type} outputs`);
    assert.ok(definition.icon, `${definition.type} icon`);
    if (definition.group === 'trigger') {
      assert.equal(definition.inputs, 0, `${definition.type} triggers take no input`);
      assert.ok(definition.triggerKind, `${definition.type} triggerKind`);
    } else {
      assert.ok(definition.execute, `${definition.type} needs an execute function`);
    }
    // Defaults must be serialisable so they can be cloned into new nodes.
    assert.doesNotThrow(() => JSON.stringify(defaultParamsFor(definition.type)));
  }
});
