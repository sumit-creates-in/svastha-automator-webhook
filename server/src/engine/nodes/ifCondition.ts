import type { NodeDefinition } from '../types';
import { CONDITION_OPERATORS, evaluateConditions, type ConditionRow } from './conditions';

export const ifCondition: NodeDefinition = {
  type: 'if',
  displayName: 'If / Else',
  group: 'logic',
  version: 1,
  description:
    'Splits the workflow into two paths. Steps connected to "true" run when the conditions match, otherwise the "false" path runs.',
  icon: 'GitBranch',
  color: '#10b981',
  inputs: 1,
  outputs: [
    { name: 'true', label: 'True', description: 'Runs when the conditions match' },
    { name: 'false', label: 'False', description: 'Runs when they do not' },
  ],
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
      label: 'Conditions',
      type: 'collection',
      default: [{ left: '', operator: 'equals', right: '' }],
      fields: [
        { name: 'left', label: 'Value', type: 'string', placeholder: '{{ $json.status }}' },
        { name: 'operator', label: 'Operator', type: 'select', default: 'equals', options: CONDITION_OPERATORS },
        { name: 'right', label: 'Compare with', type: 'string', placeholder: 'paid' },
      ],
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const { passed, results } = evaluateConditions(
      (params.conditions ?? []) as ConditionRow[],
      String(params.combinator ?? 'all'),
    );

    ctx.log(`Condition evaluated to ${passed}`);

    return {
      kind: 'output',
      data: { ...ctx.input, __condition: { passed, results } },
      outputs: [passed ? 'true' : 'false'],
    };
  },
};

export default ifCondition;
