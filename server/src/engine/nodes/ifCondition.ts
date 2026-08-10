import type { NodeDefinition } from '../types';
import {
  COMBINATOR_OPTIONS,
  CONDITION_OPERATORS,
  evaluateConditions,
  type ConditionRow,
} from './conditions';

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
      label: 'Continue on the True path when',
      type: 'select',
      default: 'all',
      options: COMBINATOR_OPTIONS,
    },
    {
      name: 'conditions',
      label: 'Conditions',
      type: 'collection',
      default: [{ left: '', operator: 'equals', right: '' }],
      description:
        'Pick the value from Available Fields on the left. Some operators (is empty, is a valid email…) need no comparison value.',
      fields: [
        { name: 'left', label: 'Value', type: 'string', placeholder: '{{ $json.status }}' },
        { name: 'operator', label: 'Operator', type: 'select', default: 'equals', options: CONDITION_OPERATORS },
        { name: 'right', label: 'Compare with', type: 'string', placeholder: 'paid' },
      ],
    },
    {
      name: 'caseSensitive',
      label: 'Match upper and lower case exactly',
      type: 'boolean',
      default: false,
      description: 'Off by default, because form data is rarely consistent.',
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const { passed, results } = evaluateConditions(
      (params.conditions ?? []) as ConditionRow[],
      String(params.combinator ?? 'all'),
      Boolean(params.caseSensitive),
    );

    // Log each line so the run history shows exactly why a branch was chosen.
    results.forEach((result) => ctx.log(result.explain));
    ctx.log(`→ taking the ${passed ? 'TRUE' : 'FALSE'} path`);

    return {
      kind: 'output',
      data: { ...ctx.input, __condition: { passed, results } },
      outputs: [passed ? 'true' : 'false'],
    };
  },
};

export default ifCondition;
