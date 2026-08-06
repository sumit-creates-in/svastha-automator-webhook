/**
 * Field discovery tests — the data behind the Available Fields panel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFieldGroup,
  buildFieldTree,
  detectType,
  flattenFields,
  nodeRootExpression,
  previewValue,
  summariseForSample,
} from './fields';
import { collectAncestors } from '../routes/workflow.routes';

const WEBHOOK_PAYLOAD = {
  method: 'POST',
  body: {
    first_name: 'Sumit',
    email: 'sumit@example.com',
    order: { id: 4821, total: 12500.5, paid: true },
    line_items: [
      { sku: 'A-1', quantity: 2 },
      { sku: 'B-7', quantity: 1 },
    ],
    notes: null,
  },
  headers: { 'content-type': 'application/json', connection: 'keep-alive' },
};

test('nested objects are discovered with usable expressions', () => {
  const fields = buildFieldTree(WEBHOOK_PAYLOAD);
  const flat = flattenFields(fields);
  const paths = flat.map((field) => field.path);

  assert.ok(paths.includes('body.first_name'));
  assert.ok(paths.includes('body.order.id'));
  assert.ok(paths.includes('body.order.total'));

  const email = flat.find((field) => field.path === 'body.email');
  assert.equal(email?.expression, '{{ $json.body.email }}');
  assert.equal(email?.type, 'string');
  assert.equal(email?.sample, 'sumit@example.com');
});

test('arrays are discovered and indexable', () => {
  const flat = flattenFields(buildFieldTree(WEBHOOK_PAYLOAD));

  const array = flat.find((field) => field.path === 'body.line_items');
  assert.equal(array?.type, 'array');
  assert.equal(array?.arrayLength, 2);
  assert.equal(array?.sample, '2 items');

  const sku = flat.find((field) => field.path === 'body.line_items[0].sku');
  assert.ok(sku, 'the first element should be described');
  assert.equal(sku?.expression, '{{ $json.body.line_items[0].sku }}');
});

test('types are detected correctly, including null', () => {
  const flat = flattenFields(buildFieldTree(WEBHOOK_PAYLOAD));
  const byPath = new Map(flat.map((field) => [field.path, field]));

  assert.equal(byPath.get('body.order.id')?.type, 'number');
  assert.equal(byPath.get('body.order.paid')?.type, 'boolean');
  assert.equal(byPath.get('body.notes')?.type, 'null');
  assert.equal(byPath.get('body.order')?.type, 'object');
  assert.equal(byPath.get('body')?.isLeaf, false);
  assert.equal(byPath.get('body.email')?.isLeaf, true);
});

test('noisy request headers are filtered out but useful ones stay', () => {
  const paths = flattenFields(buildFieldTree(WEBHOOK_PAYLOAD)).map((field) => field.path);
  assert.ok(paths.includes('headers["content-type"]'));
  assert.equal(
    paths.some((path) => path.includes('keep-alive') || path.includes('headers.connection')),
    false,
  );
});

test('awkward key names are escaped into valid expressions', () => {
  const flat = flattenFields(buildFieldTree({ 'first name': 'x', 'a-b': 1, ok_key: true }));
  const byLabel = new Map(flat.map((field) => [field.label, field]));

  assert.equal(byLabel.get('first name')?.expression, '{{ $json["first name"] }}');
  assert.equal(byLabel.get('a-b')?.expression, '{{ $json["a-b"] }}');
  assert.equal(byLabel.get('ok_key')?.expression, '{{ $json.ok_key }}');
});

test('a different root produces node-scoped expressions', () => {
  const fields = buildFieldTree({ id: 1 }, nodeRootExpression('Clean up fields'));
  assert.equal(fields[0].expression, '{{ $node["Clean up fields"].json.id }}');
});

test('step names containing quotes cannot break the expression', () => {
  const root = nodeRootExpression('He said "hi"');
  assert.equal(root, '$node["He said \\"hi\\""].json');
});

test('recursion is bounded so a pathological payload cannot hang the editor', () => {
  let deep: Record<string, unknown> = { end: true };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };

  const flat = flattenFields(buildFieldTree(deep));
  assert.ok(flat.length > 0);
  assert.ok(flat.length < 60, `expected the walk to stop early, got ${flat.length}`);

  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 3000; i += 1) wide[`key${i}`] = i;
  assert.ok(flattenFields(buildFieldTree(wide)).length <= 800);
});

test('samples are trimmed before being stored', () => {
  const summary = summariseForSample({
    long: 'x'.repeat(1000),
    list: Array.from({ length: 50 }, (_, index) => ({ index })),
    keep: 'short',
  }) as Record<string, any>;

  assert.ok(summary.long.length < 320);
  assert.equal(summary.list.length, 3, 'long arrays are cut to a representative sample');
  assert.equal(summary.keep, 'short');
});

test('previews describe containers instead of dumping them', () => {
  assert.equal(previewValue([1, 2, 3]), '3 items');
  assert.equal(previewValue({ a: 1 }), '1 field');
  assert.equal(previewValue(null), 'null');
  assert.equal(detectType([]), 'array');
});

test('a group with no sample reports itself as empty rather than guessing', () => {
  const group = buildFieldGroup({
    key: 'trigger',
    label: 'Webhook',
    root: '$json',
    value: undefined,
    source: 'none',
  });
  assert.deepEqual(group.fields, []);
  assert.equal(group.source, 'none');
});

test('ancestors are found across a branching graph', () => {
  const edges = [
    { source: 'trigger', target: 'clean' },
    { source: 'clean', target: 'email' },
    { source: 'clean', target: 'sheet' },
    { source: 'sheet', target: 'notify' },
  ];

  const forEmail = collectAncestors('email', edges);
  assert.equal(forEmail.direct, 'clean');
  assert.deepEqual(forEmail.all.sort(), ['clean', 'trigger']);

  const forNotify = collectAncestors('notify', edges);
  assert.equal(forNotify.direct, 'sheet');
  assert.deepEqual(forNotify.all.sort(), ['clean', 'sheet', 'trigger']);

  // A parallel branch must not leak into the other one.
  assert.equal(forNotify.all.includes('email'), false);
});

test('ancestor walking survives a cycle', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ];
  const result = collectAncestors('a', edges);
  assert.deepEqual(result.all.sort(), ['a', 'b']);
});
