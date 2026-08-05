import type { PropertyOption } from '../types';

export interface ConditionRow {
  left?: unknown;
  operator?: string;
  right?: unknown;
}

export const CONDITION_OPERATORS: PropertyOption[] = [
  { label: 'is equal to', value: 'equals' },
  { label: 'is not equal to', value: 'notEquals' },
  { label: 'contains', value: 'contains' },
  { label: 'does not contain', value: 'notContains' },
  { label: 'starts with', value: 'startsWith' },
  { label: 'ends with', value: 'endsWith' },
  { label: 'matches regex', value: 'regex' },
  { label: 'is empty', value: 'isEmpty' },
  { label: 'is not empty', value: 'isNotEmpty' },
  { label: 'is true', value: 'isTrue' },
  { label: 'is false', value: 'isFalse' },
  { label: 'greater than', value: 'gt' },
  { label: 'greater than or equal', value: 'gte' },
  { label: 'less than', value: 'lt' },
  { label: 'less than or equal', value: 'lte' },
  { label: 'is in list (comma separated)', value: 'in' },
  { label: 'date is after', value: 'dateAfter' },
  { label: 'date is before', value: 'dateBefore' },
];

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

export function evaluateCondition(row: ConditionRow): boolean {
  const left = row.left;
  const right = row.right;
  const leftStr = left === null || left === undefined ? '' : String(left);
  const rightStr = right === null || right === undefined ? '' : String(right);

  switch (row.operator) {
    case 'equals':
      // Loose compare so "5" from a webhook matches the number 5.
      // eslint-disable-next-line eqeqeq
      return leftStr.toLowerCase() === rightStr.toLowerCase();
    case 'notEquals':
      return leftStr.toLowerCase() !== rightStr.toLowerCase();
    case 'contains':
      return leftStr.toLowerCase().includes(rightStr.toLowerCase());
    case 'notContains':
      return !leftStr.toLowerCase().includes(rightStr.toLowerCase());
    case 'startsWith':
      return leftStr.toLowerCase().startsWith(rightStr.toLowerCase());
    case 'endsWith':
      return leftStr.toLowerCase().endsWith(rightStr.toLowerCase());
    case 'regex':
      try {
        return new RegExp(rightStr).test(leftStr);
      } catch {
        return false;
      }
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return truthy(left);
    case 'isFalse':
      return !truthy(left);
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'in':
      return rightStr
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .includes(leftStr.toLowerCase());
    case 'dateAfter':
      return new Date(leftStr).getTime() > new Date(rightStr).getTime();
    case 'dateBefore':
      return new Date(leftStr).getTime() < new Date(rightStr).getTime();
    default:
      return false;
  }
}

export function evaluateConditions(
  rows: ConditionRow[],
  combinator: string,
): { passed: boolean; results: Array<{ left: unknown; operator?: string; right: unknown; passed: boolean }> } {
  const results = rows
    .filter((row) => row && row.operator)
    .map((row) => ({
      left: row.left,
      operator: row.operator,
      right: row.right,
      passed: evaluateCondition(row),
    }));

  if (results.length === 0) return { passed: true, results };

  const passed =
    combinator === 'any' ? results.some((r) => r.passed) : results.every((r) => r.passed);

  return { passed, results };
}
