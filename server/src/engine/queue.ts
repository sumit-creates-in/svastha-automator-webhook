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
  /** Fingerprint used to ignore repeat webhook deliveries. */
  dedupeKey?: string;
  /** Execute the start node itself — used by "Run from here". */
  executeStartNode?: boolean;
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
      executeStartNode: options.executeStartNode ?? false,
    },
    steps: [],
    startedBy: options.startedBy,
    dedupeKey: options.dedupeKey,
  });

  const job = await Job.create({
    run: run._id,
    workflow: options.workflow._id,
    status: options.inline ? 'active' : 'pending',
    runAt: options.runAt ?? new Date(),
    /*
     * Attempts here mean "attempts to pick the job up", not "attempts to run
     * the workflow". Because a run resumes from persisted state and refuses to
     * execute twice, a retry continues where it left off — it never replays.
     */
    maxAttempts: options.inline ? 1 : 3,
    lockedAt: options.inline ? new Date() : undefined,
    lockedBy: options.inline ? 'inline' : undefined,
    attempts: options.inline ? 1 : 0,
  });

  return { runId: String(run._id), jobId: String(job._id) };
}

export type ClaimedJob = JobDoc;

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

/**
 * Closes off runs that can never finish.
 *
 * A run is orphaned when it is still marked `running` (or `queued`) long past
 * the point anything could still be working on it, and no job remains to pick it
 * up. That happens when the process is killed mid-step, or when a step blocked
 * for so long that its job was completed without the run reaching a conclusion.
 *
 * Leaving these sitting at "Running" forever is worse than useless — it hides
 * real failures — so they are marked as errors with an explanation.
 */
export async function reapOrphanedRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - env.engine.runTimeoutMs - 60_000);

  const candidates = await Run.find({
    status: { $in: ['running', 'queued'] },
    createdAt: { $lt: cutoff },
  })
    .select('_id workflow startedAt')
    .limit(100)
    .lean();

  if (candidates.length === 0) return 0;

  let reaped = 0;
  for (const run of candidates) {
    const liveJob = await Job.findOne({
      run: run._id,
      status: { $in: ['pending', 'active'] },
    })
      .select('_id')
      .lean();

    // Something is still queued to run it — leave it alone.
    if (liveJob) continue;

    const finishedAt = new Date();
    await Run.updateOne(
      { _id: run._id, status: { $in: ['running', 'queued'] } },
      {
        $set: {
          status: 'error',
          error:
            'This run was interrupted and never finished. The step it was on did not return in time — ' +
            'if it sends email, check that outbound SMTP is not blocked by your host, or switch the ' +
            'connection to the Gmail API.',
          finishedAt,
          durationMs: run.startedAt
            ? finishedAt.getTime() - new Date(run.startedAt).getTime()
            : 0,
          lockedBy: null,
          lockedAt: null,
        },
        $unset: { state: '' },
      },
    );
    reaped += 1;
  }

  return reaped;
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

/**
 * Hands a job straight back to the queue without counting it as an attempt.
 *
 * Used during graceful shutdown: the run has persisted its state, so another
 * instance can resume it immediately instead of waiting for the stale sweep.
 */
export async function releaseJob(job: JobDoc): Promise<void> {
  await Job.updateOne(
    { _id: job._id, status: 'active' },
    {
      $set: { status: 'pending', runAt: new Date(), lockedAt: null, lockedBy: null },
      $inc: { attempts: -1 },
    },
  ).catch(() => undefined);
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
