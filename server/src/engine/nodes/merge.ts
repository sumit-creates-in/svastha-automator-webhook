import type { NodeDefinition } from '../types';

export const merge: NodeDefinition = {
  type: 'merge',
  displayName: 'Merge Branches',
  group: 'logic',
  version: 1,
  description:
    'Waits for two branches to finish and joins them into one, so the steps after it run only once.',
  icon: 'Split',
  color: '#0d9488',
  inputs: 2,
  inputHandles: [
    { name: 'input1', label: 'Input 1' },
    { name: 'input2', label: 'Input 2' },
  ],
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'mode',
      label: 'How should the branches combine?',
      type: 'select',
      default: 'combine',
      options: [
        {
          label: 'Combine — merge the fields together',
          value: 'combine',
          description: 'Later branches overwrite earlier ones where field names clash.',
        },
        {
          label: 'Keep separate — one key per branch',
          value: 'separate',
          description: 'Produces { input1: {...}, input2: {...} }.',
        },
        {
          label: 'Append — collect into a list',
          value: 'append',
          description: 'Produces { items: [...] }.',
        },
        {
          label: 'First to arrive wins',
          value: 'first',
        },
      ],
    },
    {
      name: 'notice',
      label: 'One branch not arriving?',
      type: 'notice',
      description:
        'If a branch is stopped by a Filter or an If, the Merge still runs once everything else is done — using whatever did arrive. It will never leave a run hanging.',
    },
  ],

  async execute(ctx) {
    const mode = String((ctx.params as Record<string, unknown>).mode ?? 'combine');
    const arrivals = ctx.arrivals ?? [{ handle: 'input1', data: ctx.input }];

    ctx.log(
      `Merging ${arrivals.length} branch${arrivals.length === 1 ? '' : 'es'} using "${mode}"`,
    );

    if (mode === 'separate') {
      const data: Record<string, unknown> = {};
      arrivals.forEach((arrival, index) => {
        data[arrival.handle || `input${index + 1}`] = arrival.data;
      });
      return { kind: 'output', data };
    }

    if (mode === 'append') {
      return {
        kind: 'output',
        data: { items: arrivals.map((arrival) => arrival.data), count: arrivals.length },
      };
    }

    if (mode === 'first') {
      return { kind: 'output', data: arrivals[0]?.data ?? {} };
    }

    const combined: Record<string, unknown> = {};
    for (const arrival of arrivals) Object.assign(combined, arrival.data);
    return { kind: 'output', data: combined };
  },
};

export default merge;
