import parser from 'cron-parser';
import { toErrorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { ScheduleState } from '../models/ScheduleState';
import { Workflow, type WorkflowDoc } from '../models/Workflow';
import { enqueueRun } from './queue';
import type { WorkflowNode } from './types';

/** Turns the friendly Schedule node settings into a cron expression. */
export function buildCronExpression(params: Record<string, any>): string {
  const mode = String(params.mode ?? 'interval');
  const minute = Number(params.minute ?? 0);
  const hour = Number(params.hour ?? 9);

  switch (mode) {
    case 'interval': {
      const minutes = Math.max(1, Math.min(59, Number(params.minutes ?? 15)));
      return `*/${minutes} * * * *`;
    }
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${params.weekday ?? 1}`;
    case 'monthly':
      return `${minute} ${hour} ${Number(params.dayOfMonth ?? 1)} * *`;
    case 'cron':
    default:
      return String(params.cron ?? '0 9 * * *').trim();
  }
}

export function nextFireTime(expression: string, timezone: string, from = new Date()): Date {
  const interval = parser.parseExpression(expression, { currentDate: from, tz: timezone || 'UTC' });
  return interval.next().toDate();
}

/** Rebuilds the schedule table for one workflow. Call after every save/activate. */
export async function syncWorkflowSchedules(workflow: WorkflowDoc): Promise<void> {
  const nodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
  const scheduleNodes = nodes.filter((node) => node.type === 'scheduleTrigger' && !node.disabled);
  const keepIds: string[] = [];

  for (const node of scheduleNodes) {
    const params = (node.params ?? {}) as Record<string, any>;
    const expression = buildCronExpression(params);
    const timezone = String(params.timezone || workflow.settings?.timezone || 'UTC');

    let nextRunAt: Date;
    try {
      nextRunAt = nextFireTime(expression, timezone);
    } catch (error) {
      logger.warn(
        { workflow: String(workflow._id), node: node.id, err: toErrorMessage(error) },
        'Invalid cron expression — schedule skipped',
      );
      continue;
    }

    keepIds.push(node.id);
    await ScheduleState.findOneAndUpdate(
      { workflow: workflow._id, nodeId: node.id },
      {
        $set: {
          expression,
          timezone,
          active: Boolean(workflow.active),
          ...(await shouldResetNextRun(workflow._id.toString(), node.id, expression, timezone)
            ? { nextRunAt }
            : {}),
        },
        $setOnInsert: { nextRunAt },
      },
      { upsert: true, new: true },
    );
  }

  await ScheduleState.deleteMany({ workflow: workflow._id, nodeId: { $nin: keepIds } });
}

/** Only move nextRunAt when the schedule definition actually changed. */
async function shouldResetNextRun(
  workflowId: string,
  nodeId: string,
  expression: string,
  timezone: string,
): Promise<boolean> {
  const existing = await ScheduleState.findOne({ workflow: workflowId, nodeId }).lean();
  if (!existing) return true;
  return existing.expression !== expression || existing.timezone !== timezone;
}

export async function removeWorkflowSchedules(workflowId: string): Promise<void> {
  await ScheduleState.deleteMany({ workflow: workflowId });
}

/**
 * Checks for due schedules every 20 seconds and enqueues runs.
 * The atomic findOneAndUpdate on nextRunAt guarantees a single fire per tick,
 * even with several server instances.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('Scheduler started');
    this.timer = setInterval(() => {
      this.tick().catch((error) =>
        logger.error({ err: toErrorMessage(error) }, 'Scheduler tick failed'),
      );
    }, 20_000);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();

    for (;;) {
      const due = await ScheduleState.findOne({ active: true, nextRunAt: { $lte: now } }).sort({
        nextRunAt: 1,
      });
      if (!due) return;

      let next: Date;
      try {
        next = nextFireTime(due.expression, due.timezone, now);
      } catch {
        next = new Date(Date.now() + 60 * 60 * 1000);
      }

      // Claim the tick by advancing nextRunAt first.
      const claimed = await ScheduleState.findOneAndUpdate(
        { _id: due._id, nextRunAt: due.nextRunAt },
        { $set: { nextRunAt: next, lastRunAt: now } },
      );
      if (!claimed) continue;

      const workflow = await Workflow.findById(due.workflow);
      if (!workflow || !workflow.active) {
        await ScheduleState.updateOne({ _id: due._id }, { $set: { active: false } });
        continue;
      }

      const nodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
      const triggerNode = nodes.find((node) => node.id === due.nodeId);
      if (!triggerNode) {
        await ScheduleState.deleteOne({ _id: due._id });
        continue;
      }

      await enqueueRun({
        workflow,
        triggerNode,
        mode: 'schedule',
        payload: {
          triggeredAt: now.toISOString(),
          expression: due.expression,
          timezone: due.timezone,
        },
      });

      logger.info({ workflow: workflow.name }, 'Schedule fired');
    }
  }
}

export const scheduler = new Scheduler();
