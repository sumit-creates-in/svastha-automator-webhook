/**
 * Calculation, formatting and duplicate-protection tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import calculate, { applyOperation, applyRounding } from './nodes/calculate';
import { buildRow, formatCell } from './nodes/googleSheets';
import { expressionHelpers, resolveValue, toNumber } from './expression';
import { isTerminalStatus } from '../models/Run';
import type { ExpressionScope, NodeExecutionContext } from './types';

function scopeFor(json: Record<string, unknown>): ExpressionScope {
  return {
    $json: json,
    $trigger: json,
    $node: {},
    $vars: {},
    $runId: 'r',
    $workflowId: 'w',
    $workflowName: 'w',
    $now: '2026-08-07T09:20:00.000Z',
    $timestamp: Date.parse('2026-08-07T09:20:00.000Z'),
    $itemIndex: 0,
    $itemCount: 1,
  };
}

function ctxFor(params: Record<string, unknown>, input: Record<string, unknown> = {}) {
  const scope = scopeFor(input);
  return {
    node: { id: 'n', type: 'calculate', name: 'Calculate', position: { x: 0, y: 0 }, params },
    params: resolveValue(params, scope),
    rawParams: params,
    input,
    scope,
    runId: 'r',
    workflowId: 'w',
    getConnection: async () => ({}),
    resolve: (value: unknown) => resolveValue(value, scope),
    log: () => undefined,
    signal: new AbortController().signal,
  } as NodeExecutionContext;
}

// ---------------------------------------------------------------- arithmetic

test('the four basic operations work', () => {
  assert.equal(applyOperation(7, 3, 'add'), 10);
  assert.equal(applyOperation(7, 3, 'subtract'), 4);
  assert.equal(applyOperation(7, 3, 'multiply'), 21);
  assert.equal(applyOperation(8, 2, 'divide'), 4);
});

test('dividing by zero yields 0 rather than Infinity', () => {
  assert.equal(applyOperation(5, 0, 'divide'), 0);
  assert.equal(applyOperation(5, 0, 'modulo'), 0);
});

test('percentage operations match what people expect', () => {
  assert.equal(applyOperation(1200, 18, 'percentOf'), 216);
  assert.equal(applyOperation(1200, 18, 'addPercent'), 1416);
  assert.equal(applyOperation(1200, 18, 'subtractPercent'), 984);
});

test('rounding modes behave', () => {
  assert.equal(applyRounding(2.345, 'nearest', 2), 2.35);
  assert.equal(applyRounding(2.341, 'up', 2), 2.35);
  assert.equal(applyRounding(2.349, 'down', 2), 2.34);
  assert.equal(applyRounding(2.34567, 'none', 2), 2.34567);
  assert.equal(applyRounding(7.4, 'nearest', 0), 7);
});

test('numbers are read leniently from messy input', () => {
  assert.equal(toNumber('₹1,200.50'), 1200.5);
  assert.equal(toNumber(' 42 '), 42);
  assert.equal(toNumber('abc'), 0);
  assert.equal(toNumber(null), 0);
  assert.equal(toNumber(true), 1);
});

test('Calculate multiplies two fields from the payload', async () => {
  const result = await calculate.execute!(
    ctxFor(
      {
        mode: 'simple',
        valueA: '{{ $json.price }}',
        operation: 'multiply',
        valueB: '{{ $json.quantity }}',
        outputField: 'lineTotal',
        decimals: 2,
      },
      { price: '249.50', quantity: 3 },
    ),
  );

  assert.equal(result.kind, 'output');
  if (result.kind !== 'output') return;
  assert.equal(result.data.lineTotal, 748.5);
  assert.equal(result.data.lineTotalText, '748.50');
  assert.equal(result.data.price, '249.50', 'incoming data is kept by default');
});

test('Calculate runs a chain of steps in order', async () => {
  const result = await calculate.execute!(
    ctxFor({
      mode: 'chain',
      startValue: '1000',
      steps: [
        { operation: 'subtract', value: '100' },
        { operation: 'addPercent', value: '18' },
      ],
      outputField: 'total',
    }),
  );
  // (1000 - 100) + 18% = 1062
  assert.equal(result.kind === 'output' ? result.data.total : null, 1062);
});

test('Calculate evaluates a formula and writes to a nested field', async () => {
  const result = await calculate.execute!(
    ctxFor(
      {
        mode: 'formula',
        formula: '({{ $json.price }} * {{ $json.qty }}) * 1.18',
        outputField: 'order.grandTotal',
        decimals: 2,
      },
      { price: 100, qty: 3 },
    ),
  );

  const data = result.kind === 'output' ? (result.data as any) : null;
  assert.equal(data.order.grandTotal, 354);
});

test('a formula cannot be used to run arbitrary code', async () => {
  await assert.rejects(
    () =>
      calculate.execute!(
        ctxFor({ mode: 'formula', formula: 'process.exit(1)', outputField: 'x' }),
      ),
    /not a plain calculation|did not produce a number|Code node failed/,
  );
});

test('Calculate totals a list of line items', async () => {
  const result = await calculate.execute!(
    ctxFor(
      {
        mode: 'aggregate',
        list: '{{ $json.items }}',
        listField: 'amount',
        aggregation: 'sum',
        outputField: 'total',
      },
      { items: [{ amount: 100 }, { amount: 250.5 }, { amount: 49.5 }] },
    ),
  );
  assert.equal(result.kind === 'output' ? result.data.total : null, 400);
});

test('aggregating an empty or missing list gives 0, not an error', async () => {
  const result = await calculate.execute!(
    ctxFor({ mode: 'aggregate', list: '{{ $json.nope }}', aggregation: 'sum', outputField: 'total' }),
  );
  assert.equal(result.kind === 'output' ? result.data.total : null, 0);
});

// ----------------------------------------------------------- phone and time

test('phone numbers are normalised to international form', () => {
  const { phone } = expressionHelpers;
  assert.equal(phone('98765 43210'), '919876543210');
  assert.equal(phone('0 9876543210'), '919876543210');
  assert.equal(phone('+91-98765-43210'), '919876543210');
  assert.equal(phone('919876543210'), '919876543210', 'already prefixed is left alone');
  assert.equal(phone('9876543210', '44'), '449876543210');
  assert.equal(phone('9876543210', '91', '+'), '+919876543210');
  assert.equal(phone(''), '');
});

test('running phone twice does not double the country code', () => {
  const { phone } = expressionHelpers;
  assert.equal(phone(phone('9876543210')), '919876543210');
});

test('time is formatted as a short 12-hour string', () => {
  const { time } = expressionHelpers;
  // 09:20 UTC is 14:50 in Asia/Kolkata.
  assert.equal(time('2026-08-07T09:20:00.000Z'), '2:50 pm');
  assert.equal(time('2026-08-07T03:30:00.000Z'), '9:00 am');
  assert.equal(time('2026-08-07T09:20:00.000Z', 'UTC'), '9:20 am');
  assert.equal(time('nonsense'), '');
});

test('text() adds the spreadsheet escape once only', () => {
  const { text } = expressionHelpers;
  assert.equal(text('2:50 pm'), "'2:50 pm");
  assert.equal(text("'2:50 pm"), "'2:50 pm");
  assert.equal(text(''), '');
  assert.equal(text(919876543210), "'919876543210");
});

test('helpers are reachable from an expression', () => {
  const scope = scopeFor({ mobile: '0 98765 43210', when: '2026-08-07T09:20:00.000Z' });
  assert.equal(resolveValue('{{ $fn.phone($json.mobile) }}', scope), '919876543210');
  assert.equal(resolveValue('{{ $fn.time($json.when) }}', scope), '2:50 pm');
  assert.equal(resolveValue('{{ $fn.addPercent(1200, 18) }}', scope), 1416);
  assert.equal(resolveValue('{{ $fn.money($fn.mul(3, 249.5)) }}', scope), '748.50');
});

// -------------------------------------------------------------- sheet cells

test('cells default to text so Sheets cannot reinterpret them', () => {
  const headers = ['Name', 'Mobile', 'Time'];
  const { values } = buildRow(
    headers,
    [
      { column: 'Name', value: 'Sumit' },
      { column: 'Mobile', value: '919876543210' },
      { column: 'Time', value: '2:50 pm' },
    ],
    'text',
  );

  assert.deepEqual(values, ["'Sumit", "'919876543210", "'2:50 pm"]);
});

test('a column can opt out of text formatting for real numbers', () => {
  const { values } = buildRow(
    ['Amount', 'Mobile'],
    [
      { column: 'Amount', value: '1416.00', format: 'number' },
      { column: 'Mobile', value: '+91 98765 43210', format: 'phone' },
    ],
    'text',
  );

  assert.equal(values[0], 1416);
  assert.equal(values[1], "'919876543210");
});

test('unmatched columns are reported rather than silently dropped', () => {
  const { values, unmatched } = buildRow(
    ['Name'],
    [
      { column: 'Name', value: 'A' },
      { column: 'Nope', value: 'B' },
    ],
    'auto',
  );
  assert.deepEqual(values, ['A']);
  assert.deepEqual(unmatched, ['nope']);
});

test('formatCell handles each mode', () => {
  assert.equal(formatCell('2:50 pm', 'text'), "'2:50 pm");
  assert.equal(formatCell('0 98765 43210', 'phone'), "'09876543210");
  assert.equal(formatCell('₹1,416.50', 'number'), 1416.5);
  assert.equal(formatCell('2:50 pm', 'auto'), '2:50 pm');
  assert.equal(formatCell(null, 'text'), '');
});

// --------------------------------------------------- duplicate protection

test('terminal run statuses are recognised', () => {
  assert.equal(isTerminalStatus('success'), true);
  assert.equal(isTerminalStatus('error'), true);
  assert.equal(isTerminalStatus('cancelled'), true);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(isTerminalStatus('queued'), false);
  assert.equal(isTerminalStatus('waiting'), false);
  assert.equal(isTerminalStatus(undefined), false);
});
