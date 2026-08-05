import type { NodeDefinition } from '../types';

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

export const delay: NodeDefinition = {
  type: 'delay',
  displayName: 'Wait',
  group: 'logic',
  version: 1,
  description:
    'Pauses this branch before continuing. Long waits are persisted, so the run survives a restart or redeploy.',
  icon: 'Timer',
  color: '#a855f7',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'mode',
      label: 'Wait for',
      type: 'select',
      default: 'duration',
      options: [
        { label: 'A fixed amount of time', value: 'duration' },
        { label: 'A specific date/time', value: 'until' },
      ],
    },
    {
      name: 'amount',
      label: 'Amount',
      type: 'number',
      default: 5,
      displayOptions: { show: { mode: ['duration'] } },
    },
    {
      name: 'unit',
      label: 'Unit',
      type: 'select',
      default: 'minutes',
      options: [
        { label: 'Seconds', value: 'seconds' },
        { label: 'Minutes', value: 'minutes' },
        { label: 'Hours', value: 'hours' },
        { label: 'Days', value: 'days' },
      ],
      displayOptions: { show: { mode: ['duration'] } },
    },
    {
      name: 'until',
      label: 'Resume at',
      type: 'string',
      placeholder: '2026-08-06T09:00:00Z or {{ $json.sendAt }}',
      displayOptions: { show: { mode: ['until'] } },
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    let resumeAt: Date;

    if (String(params.mode ?? 'duration') === 'until') {
      resumeAt = new Date(String(params.until));
      if (Number.isNaN(resumeAt.getTime())) {
        throw new Error(`"${params.until}" is not a valid date/time`);
      }
    } else {
      const unit = String(params.unit ?? 'minutes');
      const ms = Number(params.amount ?? 0) * (UNIT_MS[unit] ?? UNIT_MS.minutes);
      resumeAt = new Date(Date.now() + Math.max(0, ms));
    }

    ctx.log(`Waiting until ${resumeAt.toISOString()}`);
    return { kind: 'wait', resumeAt, data: ctx.input };
  },
};

export default delay;
