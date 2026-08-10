import { setPath } from '../expression';
import {
  addToDate,
  diffDates,
  endOfDay,
  formatDateTime,
  parseDate,
  relativeToNow,
  startOfDay,
  type DateUnit,
} from '../../lib/datetime';
import type { NodeDefinition } from '../types';

const UNIT_OPTIONS = [
  { label: 'Seconds', value: 'seconds' },
  { label: 'Minutes', value: 'minutes' },
  { label: 'Hours', value: 'hours' },
  { label: 'Days', value: 'days' },
  { label: 'Weeks', value: 'weeks' },
  { label: 'Months', value: 'months' },
  { label: 'Years', value: 'years' },
];

export const dateTime: NodeDefinition = {
  type: 'dateTime',
  displayName: 'Date & Time',
  group: 'transform',
  version: 1,
  description:
    'Format a date and time into one string, add or subtract days, work out how far apart two dates are, or grab the start of the day.',
  icon: 'Calendar',
  color: '#0891b2',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'operation',
      label: 'What do you want to do?',
      type: 'select',
      default: 'format',
      options: [
        { label: 'Format into a single string', value: 'format' },
        { label: 'Add time', value: 'add' },
        { label: 'Subtract time', value: 'subtract' },
        { label: 'Difference between two dates', value: 'diff' },
        { label: 'Start of the day', value: 'startOfDay' },
        { label: 'End of the day', value: 'endOfDay' },
        { label: 'How long ago / from now', value: 'relative' },
        { label: 'Current date and time', value: 'now' },
      ],
    },
    {
      name: 'value',
      label: 'Date',
      type: 'string',
      default: '{{ $now }}',
      placeholder: '{{ $json.body.created_at }}',
      description:
        'Accepts ISO dates, timestamps and DD/MM/YYYY. Leave as {{ $now }} for the current moment.',
      displayOptions: { hide: { operation: ['now'] } },
    },
    {
      name: 'secondValue',
      label: 'Compared with',
      type: 'string',
      default: '{{ $now }}',
      displayOptions: { show: { operation: ['diff'] } },
    },
    {
      name: 'amount',
      label: 'How much',
      type: 'number',
      default: 1,
      displayOptions: { show: { operation: ['add', 'subtract'] } },
    },
    {
      name: 'unit',
      label: 'Unit',
      type: 'select',
      default: 'days',
      options: UNIT_OPTIONS,
      displayOptions: { show: { operation: ['add', 'subtract', 'diff'] } },
    },
    {
      name: 'pattern',
      label: 'Format',
      type: 'string',
      default: 'DD MMM YYYY, h:mm a',
      placeholder: 'DD MMM YYYY, h:mm a',
      description:
        'YYYY year · MMMM/MMM/MM month · DD day · Do 7th · dddd/ddd weekday · HH 24-hour · h 12-hour · mm minutes · ss seconds · a am/pm · Z timezone. Put fixed words in square brackets: [Received on] DD MMM.',
      displayOptions: { hide: { operation: ['diff', 'relative'] } },
    },
    {
      name: 'timezone',
      label: 'Timezone',
      type: 'string',
      default: 'Asia/Kolkata',
      description: 'IANA name, e.g. Asia/Kolkata, Europe/London, UTC.',
    },
    {
      name: 'decimals',
      label: 'Decimal places',
      type: 'number',
      default: 0,
      displayOptions: { show: { operation: ['diff'] } },
    },
    {
      name: 'outputField',
      label: 'Save the answer as',
      type: 'string',
      default: 'formattedDate',
      required: true,
      placeholder: 'order.placedAt',
      description: 'Dot notation is allowed.',
    },
    {
      name: 'keepInput',
      label: 'Keep the incoming data',
      type: 'boolean',
      default: true,
    },
    {
      name: 'notice',
      label: 'Combining date and time',
      type: 'notice',
      description:
        'One pattern produces one string. "DD MMM YYYY [at] h:mm a" gives "07 Aug 2026 at 2:50 pm".',
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const operation = String(params.operation ?? 'format');
    const timezone = String(params.timezone || 'Asia/Kolkata');
    const pattern = String(params.pattern || 'DD MMM YYYY, h:mm a');

    const source = operation === 'now' ? new Date() : parseDate(params.value);
    if (operation !== 'now' && !source) {
      throw new Error(
        `"${params.value}" is not a date we can read. Try an ISO date such as 2026-08-07T09:20:00Z, a timestamp, or DD/MM/YYYY.`,
      );
    }

    let result: unknown;
    let iso: string | undefined;

    switch (operation) {
      case 'add':
      case 'subtract': {
        const amount = Number(params.amount ?? 1) * (operation === 'subtract' ? -1 : 1);
        const shifted = addToDate(source, amount, String(params.unit ?? 'days') as DateUnit);
        if (!shifted) throw new Error('Could not work that date out');
        iso = shifted.toISOString();
        result = formatDateTime(shifted, pattern, timezone);
        break;
      }

      case 'diff': {
        const other = parseDate(params.secondValue);
        if (!other) throw new Error(`"${params.secondValue}" is not a date we can read`);
        const raw = diffDates(source, other, String(params.unit ?? 'days') as DateUnit);
        const decimals = Math.max(0, Math.min(6, Number(params.decimals ?? 0)));
        result = Number(raw.toFixed(decimals));
        break;
      }

      case 'startOfDay': {
        const start = startOfDay(source, timezone);
        if (!start) throw new Error('Could not work that date out');
        iso = start.toISOString();
        result = formatDateTime(start, pattern, timezone);
        break;
      }

      case 'endOfDay': {
        const end = endOfDay(source, timezone);
        if (!end) throw new Error('Could not work that date out');
        iso = end.toISOString();
        result = formatDateTime(end, pattern, timezone);
        break;
      }

      case 'relative':
        result = relativeToNow(source);
        break;

      case 'now':
      case 'format':
      default:
        iso = (source as Date).toISOString();
        result = formatDateTime(source, pattern, timezone);
        break;
    }

    const field = String(params.outputField ?? 'formattedDate').trim() || 'formattedDate';
    const data: Record<string, unknown> =
      params.keepInput === false ? {} : structuredClone(ctx.input ?? {});

    setPath(data, field, result);
    // The ISO form is what you feed back into other date steps or store in a database.
    if (iso) setPath(data, `${field}Iso`, iso);

    ctx.log(`${operation} → ${String(result)}`);
    return { kind: 'output', data };
  },
};

export default dateTime;
