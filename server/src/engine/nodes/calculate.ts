import { setPath } from '../expression';
import { toNumber } from '../expression';
import { runSandboxedCode } from '../sandbox';
import type { NodeDefinition } from '../types';

type Operation =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'power'
  | 'percentOf'
  | 'addPercent'
  | 'subtractPercent'
  | 'min'
  | 'max';

/** Applies a two-value operation. Division by zero yields 0 rather than Infinity. */
export function applyOperation(a: number, b: number, operation: Operation): number {
  switch (operation) {
    case 'add':
      return a + b;
    case 'subtract':
      return a - b;
    case 'multiply':
      return a * b;
    case 'divide':
      return b === 0 ? 0 : a / b;
    case 'modulo':
      return b === 0 ? 0 : a % b;
    case 'power':
      return a ** b;
    case 'percentOf':
      return (a * b) / 100;
    case 'addPercent':
      return a + (a * b) / 100;
    case 'subtractPercent':
      return a - (a * b) / 100;
    case 'min':
      return Math.min(a, b);
    case 'max':
      return Math.max(a, b);
    default:
      return a;
  }
}

export function applyRounding(value: number, mode: string, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.min(10, decimals));
  switch (mode) {
    case 'up':
      return Math.ceil(value * factor) / factor;
    case 'down':
      return Math.floor(value * factor) / factor;
    case 'none':
      return value;
    case 'nearest':
    default:
      return Math.round(value * factor) / factor;
  }
}

export const calculate: NodeDefinition = {
  type: 'calculate',
  displayName: 'Calculate',
  group: 'transform',
  version: 1,
  description:
    'Adds, subtracts, multiplies, divides and works out percentages — order totals, tax, discounts, commission — without writing code.',
  icon: 'Calculator',
  color: '#d97706',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'mode',
      label: 'How do you want to calculate?',
      type: 'select',
      default: 'simple',
      options: [
        { label: 'Two values and an operation', value: 'simple' },
        { label: 'A chain of steps', value: 'chain' },
        { label: 'A formula', value: 'formula' },
        { label: 'Totals from a list', value: 'aggregate' },
      ],
    },

    // --- simple ------------------------------------------------------------
    {
      name: 'valueA',
      label: 'First value',
      type: 'string',
      default: '',
      placeholder: '{{ $json.price }}',
      displayOptions: { show: { mode: ['simple'] } },
    },
    {
      name: 'operation',
      label: 'Operation',
      type: 'select',
      default: 'multiply',
      options: [
        { label: 'Add  ( + )', value: 'add' },
        { label: 'Subtract  ( − )', value: 'subtract' },
        { label: 'Multiply  ( × )', value: 'multiply' },
        { label: 'Divide  ( ÷ )', value: 'divide' },
        { label: 'Remainder  ( mod )', value: 'modulo' },
        { label: 'To the power of  ( ^ )', value: 'power' },
        { label: 'Percent of  — 18% of 1200 = 216', value: 'percentOf' },
        { label: 'Add percent  — 1200 + 18% = 1416', value: 'addPercent' },
        { label: 'Subtract percent  — 1200 − 18% = 984', value: 'subtractPercent' },
        { label: 'Smaller of the two', value: 'min' },
        { label: 'Larger of the two', value: 'max' },
      ],
      displayOptions: { show: { mode: ['simple'] } },
    },
    {
      name: 'valueB',
      label: 'Second value',
      type: 'string',
      default: '',
      placeholder: '{{ $json.quantity }}',
      displayOptions: { show: { mode: ['simple'] } },
    },

    // --- chain -------------------------------------------------------------
    {
      name: 'startValue',
      label: 'Start from',
      type: 'string',
      default: '',
      placeholder: '{{ $json.subtotal }}',
      displayOptions: { show: { mode: ['chain'] } },
    },
    {
      name: 'steps',
      label: 'Then, in order',
      type: 'collection',
      default: [{ operation: 'multiply', value: '' }],
      description: 'Each step is applied to the running total, top to bottom.',
      fields: [
        {
          name: 'operation',
          label: 'Operation',
          type: 'select',
          default: 'add',
          options: [
            { label: '+ add', value: 'add' },
            { label: '− subtract', value: 'subtract' },
            { label: '× multiply', value: 'multiply' },
            { label: '÷ divide', value: 'divide' },
            { label: '% percent of', value: 'percentOf' },
            { label: '+% add percent', value: 'addPercent' },
            { label: '−% subtract percent', value: 'subtractPercent' },
          ],
        },
        { name: 'value', label: 'Value', type: 'string', placeholder: '18' },
      ],
      displayOptions: { show: { mode: ['chain'] } },
    },

    // --- formula -----------------------------------------------------------
    {
      name: 'formula',
      label: 'Formula',
      type: 'text',
      rows: 3,
      default: '',
      placeholder: '({{ $json.price }} * {{ $json.quantity }}) * 1.18',
      description:
        'Ordinary arithmetic: + − * / ( ) and %. Insert values from Available Fields. Functions: round, floor, ceil, abs, min, max, sqrt.',
      displayOptions: { show: { mode: ['formula'] } },
    },

    // --- aggregate ---------------------------------------------------------
    {
      name: 'list',
      label: 'List to total up',
      type: 'string',
      default: '',
      placeholder: '{{ $json.body.line_items }}',
      description: 'An array. Arrays are marked [ ] in Available Fields.',
      displayOptions: { show: { mode: ['aggregate'] } },
    },
    {
      name: 'listField',
      label: 'Field within each item',
      type: 'string',
      placeholder: 'amount',
      description: 'Leave blank if the list holds plain numbers.',
      displayOptions: { show: { mode: ['aggregate'] } },
    },
    {
      name: 'aggregation',
      label: 'Work out the',
      type: 'select',
      default: 'sum',
      options: [
        { label: 'Total (sum)', value: 'sum' },
        { label: 'Average', value: 'avg' },
        { label: 'Count', value: 'count' },
        { label: 'Smallest', value: 'min' },
        { label: 'Largest', value: 'max' },
      ],
      displayOptions: { show: { mode: ['aggregate'] } },
    },

    // --- shared ------------------------------------------------------------
    {
      name: 'rounding',
      label: 'Rounding',
      type: 'select',
      default: 'nearest',
      options: [
        { label: 'Nearest', value: 'nearest' },
        { label: 'Always up', value: 'up' },
        { label: 'Always down', value: 'down' },
        { label: 'None', value: 'none' },
      ],
    },
    {
      name: 'decimals',
      label: 'Decimal places',
      type: 'number',
      default: 2,
      displayOptions: { hide: { rounding: ['none'] } },
    },
    {
      name: 'outputField',
      label: 'Save the answer as',
      type: 'string',
      default: 'result',
      required: true,
      placeholder: 'order.total',
      description: 'Dot notation is allowed, e.g. order.total.',
    },
    {
      name: 'alsoAsText',
      label: 'Also provide a formatted version',
      type: 'boolean',
      default: true,
      description:
        'Adds "<field>Text" with the decimals fixed, e.g. 1416.00 — useful for emails and spreadsheets.',
    },
    {
      name: 'keepInput',
      label: 'Keep the incoming data',
      type: 'boolean',
      default: true,
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const mode = String(params.mode ?? 'simple');
    let result = 0;
    let workingOut = '';

    if (mode === 'simple') {
      const a = toNumber(params.valueA);
      const b = toNumber(params.valueB);
      const operation = String(params.operation ?? 'multiply') as Operation;
      result = applyOperation(a, b, operation);
      workingOut = `${a} ${operation} ${b} = ${result}`;
    } else if (mode === 'chain') {
      result = toNumber(params.startValue);
      const parts = [String(result)];

      for (const step of (params.steps ?? []) as Array<{ operation?: string; value?: unknown }>) {
        if (!step?.operation) continue;
        const operand = toNumber(step.value);
        result = applyOperation(result, operand, step.operation as Operation);
        parts.push(`${step.operation} ${operand} → ${result}`);
      }
      workingOut = parts.join('  ');
    } else if (mode === 'aggregate') {
      const list = resolveList(params.list);
      const field = String(params.listField ?? '').trim();
      const numbers = list.map((item) => {
        if (!field) return toNumber(item);
        if (item && typeof item === 'object') {
          return toNumber((item as Record<string, unknown>)[field]);
        }
        return toNumber(item);
      });

      const aggregation = String(params.aggregation ?? 'sum');
      if (numbers.length === 0) {
        result = 0;
      } else if (aggregation === 'sum') {
        result = numbers.reduce((total, value) => total + value, 0);
      } else if (aggregation === 'avg') {
        result = numbers.reduce((total, value) => total + value, 0) / numbers.length;
      } else if (aggregation === 'count') {
        result = numbers.length;
      } else if (aggregation === 'min') {
        result = Math.min(...numbers);
      } else {
        result = Math.max(...numbers);
      }
      workingOut = `${aggregation} of ${numbers.length} value(s) = ${result}`;
    } else {
      // Formula mode. Expressions have already been substituted, so what is left
      // must be plain arithmetic — anything else is rejected before evaluation.
      const formula = String(params.formula ?? '').trim();
      if (!formula) throw new Error('Enter a formula');

      const guarded = formula.replace(/\bpercent\s*\(/gi, 'PERCENT(');
      if (!/^[0-9+\-*/%().,\s a-zA-Z_]*$/.test(guarded) || /[a-zA-Z_]{2,}\s*[^(]/.test(
        guarded.replace(/\b(round|floor|ceil|abs|min|max|sqrt|pow|PERCENT)\b/g, ''),
      )) {
        throw new Error(
          `"${formula}" is not a plain calculation. Only numbers, + − * / ( ) and the listed functions are allowed — check that every field resolved to a number.`,
        );
      }

      const { value } = await runSandboxedCode(
        `const {round,floor,ceil,abs,min,max,sqrt,pow}=Math;const PERCENT=(a,b)=>a*b/100;return (${guarded});`,
        {},
        2000,
      );

      result = toNumber(value);
      if (!Number.isFinite(result)) {
        throw new Error(`"${formula}" did not produce a number. Check for a division by zero.`);
      }
      workingOut = `${formula} = ${result}`;
    }

    const rounding = String(params.rounding ?? 'nearest');
    const decimals = Number(params.decimals ?? 2);
    result = applyRounding(result, rounding, decimals);

    if (!Number.isFinite(result)) result = 0;

    const field = String(params.outputField ?? 'result').trim() || 'result';
    const data: Record<string, unknown> =
      params.keepInput === false ? {} : structuredClone(ctx.input ?? {});

    setPath(data, field, result);
    if (params.alsoAsText !== false) {
      setPath(data, `${field}Text`, result.toFixed(rounding === 'none' ? 2 : Math.max(0, decimals)));
    }

    ctx.log(workingOut);
    return { kind: 'output', data };
  },
};

/** Accepts a real array, a JSON string, or a single value. */
function resolveList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

export default calculate;
