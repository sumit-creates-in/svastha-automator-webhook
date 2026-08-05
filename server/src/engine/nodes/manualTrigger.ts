import type { NodeDefinition } from '../types';

export const manualTrigger: NodeDefinition = {
  type: 'manualTrigger',
  displayName: 'Manual / Test',
  group: 'trigger',
  version: 1,
  description:
    'Runs only when you press "Run" in the editor. Ideal while building, and for on-demand jobs.',
  icon: 'MousePointerClick',
  color: '#64748b',
  inputs: 0,
  outputs: [{ name: 'main', label: 'Output' }],
  triggerKind: 'manual',
  properties: [
    {
      name: 'sampleData',
      label: 'Sample data',
      type: 'json',
      default: '{\n  "example": "value"\n}',
      description: 'Test payload passed to the next node when you run the workflow manually.',
      rows: 8,
    },
  ],
};

export default manualTrigger;
