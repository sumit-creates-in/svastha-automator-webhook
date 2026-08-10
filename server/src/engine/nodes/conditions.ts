import type { PropertyOption } from '../types';

export interface ConditionRow {
  left?: unknown;
  operator?: string;
  right?: unknown;
}

export const CONDITION_OPERATORS: PropertyOption[] = [
  // Text
  { label: 'Text — is exactly', value: 'equals' },
  { label: 'Text — is not', value: 'notEquals' },
  { label: 'Text — contains', value: 'contains' },
  { label: 'Text — does not contain', value: 'notContains' },
  { label: 'Text — starts with', value: 'startsWith' },
  { label: 'Text — ends with', value: 'endsWith' },
  { label: 'Text — matches pattern (regex)', value: 'regex' },
  {
    label: 'Text — contains any of these (comma separated)',
    value: 'containsAny',
  },
  { label: 'Text — contains all of these (comma separated)', value: 'containsAll' },
  { label: 'Text — is one of (comma separated)', value: 'in' },
  { label: 'Text — is none of (comma separated)', value: 'notIn' },
  { label: 'Text — is longer than', value: 'longerThan' },
  { label: 'Text — is shorter than', value: 'shorterThan' },

  // Presence
  { label: 'Is empty', value: 'isEmpty' },
  { label: 'Is not empty', value: 'isNotEmpty' },
  { label: 'Exists', value: 'exists' },
  { label: 'Does not exist', value: 'notExists' },

  // Yes / no
  { label: 'Is true / yes / on', value: 'isTrue' },
  { label: 'Is false / no / off', value: 'isFalse' },

  // Numbers
  { label: 'Number — greater than', value: 'gt' },
  { label: 'Number — greater than or equal to', value: 'gte' },
  { label: 'Number — less than', value: 'lt' },
  { label: 'Number — less than or equal to', value: 'lte' },
  { label: 'Number — equals', value: 'numberEquals' },
  { label: 'Number — is between (e.g. 10,100)', value: 'between' },
  { label: 'Number — is a valid number', value: 'isNumber' },
  { label: 'Number — divides evenly by', value: 'divisibleBy' },

  // Dates
  { label: 'Date — is after', value: 'dateAfter' },
  { label: 'Date — is before', value: 'dateBefore' },
  { label: 'Date — is the same day as', value: 'sameDay' },
  { label: 'Date — is within the last N days', value: 'withinLastDays' },
  { label: 'Date — is in the next N days', value: 'withinNextDays' },
  { label: 'Date — is in the past', value: 'inPast' },
  { label: 'Date — is in the future', value: 'inFuture' },
  { label: 'Date — day of week is (e.g. Monday)', value: 'dayOfWeek' },

  // Formats
  { label: 'Looks like an email address', value: 'isEmail' },
  { label: 'Looks like a web address', value: 'isUrl' },
  { label: 'Looks like a phone number', value: 'isPhone' },

  // Lists
  { label: 'List — has any items', value: 'listNotEmpty' },
  { label: 'List — item count equals', value: 'listCount' },
  { label: 'List — includes the value', value: 'listIncludes' },
];

/** Operators that need no comparison value, so the UI can hide that box. */
export const UNARY_OPERATORS = new Set([
  'isEmpty',
  'isNotEmpty',
  'exists',
  'notExists',
  'isTrue',
  'isFalse',
  'isNumber',
  'inPast',
  'inFuture',
  'isEmail',
  'isUrl',
  'isPhone',
  'listNotEmpty',
]);

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Lenient number parsing so "₹1,200" compares as 1200.
 *
 * Returns NaN — not 0 — for values with no digits at all. Defaulting to zero
 * made `is a valid number` answer true for "abc", and quietly turned nonsense
 * into a real comparison.
 */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = String(value ?? '');
  if (!/\d/.test(text)) return NaN;

  const parsed = Number(text.replace(/[^0-9.\-eE]/g, ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function evaluateCondition(row: ConditionRow, caseSensitive = false): boolean {
  const left = row.left;
  const right = row.right;

  const rawLeft = left === null || left === undefined ? '' : String(left);
  const rawRight = right === null || right === undefined ? '' : String(right);

  // Comparisons ignore case by default — webhook data is rarely consistent.
  const l = caseSensitive ? rawLeft : rawLeft.toLowerCase();
  const r = caseSensitive ? rawRight : rawRight.toLowerCase();

  const leftDate = () => new Date(rawLeft).getTime();
  const rightDate = () => new Date(rawRight).getTime();
  const DAY_MS = 86_400_000;

  switch (row.operator) {
    // ---- text -------------------------------------------------------------
    case 'equals':
      return l === r;
    case 'notEquals':
      return l !== r;
    case 'contains':
      return l.includes(r);
    case 'notContains':
      return !l.includes(r);
    case 'startsWith':
      return l.startsWith(r);
    case 'endsWith':
      return l.endsWith(r);
    case 'regex':
      try {
        return new RegExp(rawRight, caseSensitive ? '' : 'i').test(rawLeft);
      } catch {
        return false;
      }
    case 'containsAny':
      return list(r).some((entry) => l.includes(entry));
    case 'containsAll':
      return list(r).every((entry) => l.includes(entry));
    case 'in':
      return list(r).includes(l);
    case 'notIn':
      return !list(r).includes(l);
    case 'longerThan':
      return rawLeft.length > num(right);
    case 'shorterThan':
      return rawLeft.length < num(right);

    // ---- presence ---------------------------------------------------------
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'exists':
      return left !== undefined && left !== null;
    case 'notExists':
      return left === undefined || left === null;

    // ---- yes / no ---------------------------------------------------------
    case 'isTrue':
      return truthy(left);
    case 'isFalse':
      return !truthy(left);

    // ---- numbers ----------------------------------------------------------
    case 'gt':
      return num(left) > num(right);
    case 'gte':
      return num(left) >= num(right);
    case 'lt':
      return num(left) < num(right);
    case 'lte':
      return num(left) <= num(right);
    case 'numberEquals':
      return num(left) === num(right);
    case 'between': {
      const [low, high] = list(rawRight).map(num);
      const value = num(left);
      if (Number.isNaN(value) || Number.isNaN(low) || Number.isNaN(high)) return false;
      return value >= Math.min(low, high) && value <= Math.max(low, high);
    }
    case 'isNumber':
      return rawLeft.trim() !== '' && !Number.isNaN(num(left));
    case 'divisibleBy': {
      const divisor = num(right);
      return divisor !== 0 && num(left) % divisor === 0;
    }

    // ---- dates ------------------------------------------------------------
    case 'dateAfter':
      return leftDate() > rightDate();
    case 'dateBefore':
      return leftDate() < rightDate();
    case 'sameDay': {
      const a = new Date(rawLeft);
      const b = new Date(rawRight);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
      return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
    }
    case 'withinLastDays': {
      const time = leftDate();
      if (Number.isNaN(time)) return false;
      const days = num(right);
      return time <= Date.now() && time >= Date.now() - days * DAY_MS;
    }
    case 'withinNextDays': {
      const time = leftDate();
      if (Number.isNaN(time)) return false;
      const days = num(right);
      return time >= Date.now() && time <= Date.now() + days * DAY_MS;
    }
    case 'inPast':
      return !Number.isNaN(leftDate()) && leftDate() < Date.now();
    case 'inFuture':
      return !Number.isNaN(leftDate()) && leftDate() > Date.now();
    case 'dayOfWeek': {
      const time = leftDate();
      if (Number.isNaN(time)) return false;
      const wanted = list(r).map((entry) => entry.slice(0, 3));
      const actual = DAYS[new Date(time).getUTCDay()].slice(0, 3);
      return wanted.includes(actual);
    }

    // ---- formats ----------------------------------------------------------
    case 'isEmail':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawLeft.trim());
    case 'isUrl':
      try {
        const url = new URL(rawLeft.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    case 'isPhone': {
      const digits = rawLeft.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    }

    // ---- lists ------------------------------------------------------------
    case 'listNotEmpty':
      return Array.isArray(left) && left.length > 0;
    case 'listCount':
      return Array.isArray(left) && left.length === num(right);
    case 'listIncludes':
      return (
        Array.isArray(left) &&
        left.some((entry) => {
          const text = String(entry ?? '');
          return (caseSensitive ? text : text.toLowerCase()) === r;
        })
      );

    default:
      return false;
  }
}

export interface ConditionResult {
  left: unknown;
  operator?: string;
  right: unknown;
  passed: boolean;
  /** Human-readable line for the run log. */
  explain: string;
}

function describe(row: ConditionRow, passed: boolean): string {
  const label =
    CONDITION_OPERATORS.find((option) => option.value === row.operator)?.label ?? row.operator ?? '';
  const left = row.left === undefined ? '(missing)' : JSON.stringify(row.left);
  const right = UNARY_OPERATORS.has(String(row.operator))
    ? ''
    : ` ${JSON.stringify(row.right ?? '')}`;
  return `${passed ? 'PASS' : 'FAIL'}  ${left} ${label}${right}`;
}

export function evaluateConditions(
  rows: ConditionRow[],
  combinator: string,
  caseSensitive = false,
): { passed: boolean; results: ConditionResult[] } {
  const results = rows
    .filter((row) => row && row.operator)
    .map((row) => {
      const passed = evaluateCondition(row, caseSensitive);
      return {
        left: row.left,
        operator: row.operator,
        right: row.right,
        passed,
        explain: describe(row, passed),
      };
    });

  // No conditions means "let everything through" — a gate you haven't
  // configured should not silently block the workflow.
  if (results.length === 0) return { passed: true, results };

  let passed: boolean;
  if (combinator === 'any') passed = results.some((result) => result.passed);
  else if (combinator === 'none') passed = !results.some((result) => result.passed);
  else passed = results.every((result) => result.passed);

  return { passed, results };
}

/** Shared config shared by the If and Filter nodes. */
export const COMBINATOR_OPTIONS: PropertyOption[] = [
  { label: 'ALL of these are true (AND)', value: 'all' },
  { label: 'ANY of these is true (OR)', value: 'any' },
  { label: 'NONE of these are true', value: 'none' },
];
