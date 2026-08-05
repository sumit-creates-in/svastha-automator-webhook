import type { NodeDefinition } from '../types';
import { CONDITION_OPERATORS, evaluateConditions, type ConditionRow } from './conditions';

export const filter: NodeDefinition = {
  type: 'filter',
  displayName: 'Filter',
  group: 'logic',
  version: 1,
  description:
    'Stops the workflow unless the conditions match. Use it as a gate — e.g. only continue for orders over 5000.',
  icon: 'Filter',
  color: '#14b8a6',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Passed' }],
  properties: [
    {
      name: 'combinator',
      label: 'Match',
      type: 'select',
      default: 'all',
      options: [
        { label: 'ALL conditions (AND)', value: 'all' },
        { label: 'ANY condition (OR)', value: 'any' },
      ],
    },
    {
      name: 'conditions',
      label: 'Continue only when',
      type: 'collection',
      default: [{ left: '', operator: 'isNotEmpty', right: '' }],
      fields: [
        { name: 'left', label: 'Value', type: 'string', placeholder: '{{ $json.email }}' },
        { name: 'operator', label: 'Operator', type: 'select', default: 'equals', options: CONDITION_OPERATORS },
        { name: 'right', label: 'Compare with', type: 'string' },
      ],
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const { passed, results } = evaluateConditions(
      (params.conditions ?? []) as ConditionRow[],
      String(params.combinator ?? 'all'),
    );

    if (!passed) {
      ctx.log('Filter did not pass — this branch stops here.');
      return { kind: 'stop', reason: 'Filter conditions not met', data: { passed, results } };
    }

    return { kind: 'output', data: ctx.input };
  },
};

export default filter;
