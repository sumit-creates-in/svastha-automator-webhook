import { Types } from 'mongoose';
import { env } from '../config/env';
import { Job, type JobDoc } from '../models/Job';
import { Run } from '../models/Run';
import { Workflow, type WorkflowDoc } from '../models/Workflow';
import { summariseForSample } from './fields';
import type { WorkflowNode } from './types';

export interface EnqueueOptions {
  workflow: WorkflowDoc | (WorkflowDoc & { _id: Types.ObjectId });
  triggerNode: WorkflowNode;
  payload: Record<string, unknown>;
  mode: 'webhook' | 'schedule' | 'manual' | 'test';
  startedBy?: string;
  runAt?: Date;
  /** Claim the job immediately so the caller can execute it in-process. */
  inline?: boolean;
}

export interface EnqueueResult {
  runId: string;
  jobId: string;
}

/** Creates a Run + Job pair. The worker picks it up on its next poll. */
export async function enqueueRun(options: EnqueueOptions): Promise<EnqueueResult> {
  // Remember what the trigger sent so the editor can offer real field names.
  // Done here rather than at the end of the run so the payload is captured even
  // if the workflow goes on to fail — which is exactly when you need to inspect it.
  if (
    options.mode !== 'manual' ||
    Object.keys(options.payload ?? {}).length > 0
  ) {
    await Workflow.updateOne(
      { _id: options.workflow._id, 'settings.captureSampleData': { $ne: false } },
      {
        $set: {
          sampleData: {
            payload: summariseForSample(options.payload),
            nodeId: options.triggerNode.id,
            capturedAt: new Date(),
            mode: options.mode,
          },
        },
      },
    ).catch(() => undefined);
  }

  const run = await Run.create({
    workflow: options.workflow._id,
    workflowName: options.workflow.name,
    status: 'queued',
    mode: options.mode,
    trigger: {
      nodeId: options.triggerNode.id,
      nodeName: options.triggerNode.name,
      payload: options.payload,
    },
    steps: [],
    startedBy: options.startedBy,
  });

  const job = await Job.create({
    run: run._id,
    workflow: options.workflow._id,
    status: options.inline ? 'active' : 'pending',
    runAt: options.runAt ?? new Date(),
    maxAttempts: options.inline ? 1 : 3,
    lockedAt: options.inline ? new Date() : undefined,
    lockedBy: options.inline ? 'inline' : undefined,
    attempts: options.inline ? 1 : 0,
  });

  return { runId: String(run._id), jobId: String(job._id) };
}

/** Atomically claims the next due job for this worker. */
export async function claimNextJob(workerId: string): Promise<JobDoc | null> {
  const now = new Date();

  const job = await Job.findOneAndUpdate(
    { status: 'pending', runAt: { $lte: now } },
    {
      $set: { status: 'active', lockedAt: now, lockedBy: workerId },
      $inc: { attempts: 1 },
    },
    { sort: { priority: -1, runAt: 1 }, new: true },
  );

  return job;
}

/** Returns jobs that were locked but never finished (crashed worker) to the pool. */
export async function reclaimStalledJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - env.engine.stalledAfterMs);
  const result = await Job.updateMany(
    { status: 'active', lockedAt: { $lt: cutoff } },
    { $set: { status: 'pending', lockedAt: null, lockedBy: null } },
  );
  return result.modifiedCount ?? 0;
}

export async function completeJob(job: JobDoc): Promise<void> {
  job.set('status', 'done');
  job.set('lockedAt', undefined);
  await job.save();
}

export async function failJob(job: JobDoc, error: string): Promise<void> {
  const canRetry = job.attempts < job.maxAttempts;
  job.set('status', canRetry ? 'pending' : 'failed');
  job.set('lastError', error);
  job.set('lockedAt', undefined);
  job.set('lockedBy', undefined);
  if (canRetry) {
    const backoffMs = Math.min(60_000, 2 ** job.attempts * 1000);
    job.set('runAt', new Date(Date.now() + backoffMs));
  }
  await job.save();
}

/** Re-schedules a job for a paused (waiting) run. */
export async function deferJob(job: JobDoc, resumeAt: Date): Promise<void> {
  job.set('status', 'pending');
  job.set('runAt', resumeAt);
  job.set('attempts', 0);
  job.set('lockedAt', undefined);
  job.set('lockedBy', undefined);
  await job.save();
}

export async function cancelRun(runId: string): Promise<void> {
  await Job.updateMany({ run: runId, status: { $in: ['pending', 'active'] } }, { $set: { status: 'failed', lastError: 'Cancelled' } });
  await Run.updateOne(
    { _id: runId, status: { $in: ['queued', 'running', 'waiting'] } },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
  );
}

export async function queueDepth(): Promise<{ pending: number; active: number }> {
  const [pending, active] = await Promise.all([
    Job.countDocuments({ status: 'pending' }),
    Job.countDocuments({ status: 'active' }),
  ]);
  return { pending, active };
}

export async function findWorkflowTrigger(
  workflowId: string,
  kind?: 'webhook' | 'schedule' | 'manual',
): Promise<WorkflowNode | undefined> {
  const workflow = await Workflow.findById(workflowId).lean();
  if (!workflow) return undefined;
  const nodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
  const { getNodeDefinition } = await import('./registry');
  return nodes.find((node) => {
    const definition = getNodeDefinition(node.type);
    if (!definition || definition.group !== 'trigger') return false;
    return kind ? definition.triggerKind === kind : true;
  });
}
