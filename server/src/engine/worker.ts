import crypto from 'node:crypto';
import { env } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { executeRun } from './executor';
import {
  claimNextJob,
  completeJob,
  deferJob,
  failJob,
  releaseJob,
  reclaimStalledJobs,
  type ClaimedJob,
} from './queue';

/**
 * Polls the MongoDB job queue and executes runs. Several instances can run
 * safely — jobs are claimed atomically, and `executeRun` additionally locks the
 * run itself.
 */
export class Worker {
  public readonly id = `${process.env.RAILWAY_REPLICA_ID ?? 'local'}-${crypto
    .randomBytes(4)
    .toString('hex')}`;

  private running = false;
  private inFlight = new Map<string, ClaimedJob>();
  private timer?: NodeJS.Timeout;
  private reclaimTimer?: NodeJS.Timeout;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(
      { workerId: this.id, concurrency: env.engine.concurrency },
      'Engine worker started',
    );
    this.loop();
    this.reclaimTimer = setInterval(() => {
      reclaimStalledJobs()
        .then((count) => {
          if (count > 0) logger.warn({ count }, 'Reclaimed stalled jobs');
        })
        .catch((error) => logger.error({ err: toErrorMessage(error) }, 'Reclaim failed'));
    }, 60_000);
  }

  /**
   * Graceful shutdown.
   *
   * Platforms such as Railway restart containers routinely, so this path is hot,
   * not exceptional. In-flight runs have already persisted their state after
   * every step; here we simply hand the jobs straight back to the queue so
   * another instance resumes them in seconds rather than waiting for the
   * ten-minute stale sweep.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);

    const deadline = Date.now() + 8000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.inFlight.size > 0) {
      logger.warn(
        { count: this.inFlight.size },
        'Releasing in-flight jobs so another instance can resume them',
      );
      await Promise.allSettled([...this.inFlight.values()].map((job) => releaseJob(job)));
    }

    logger.info('Engine worker stopped');
  }

  private loop(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error) => logger.error({ err: toErrorMessage(error) }, 'Worker tick failed'))
        .finally(() => this.loop());
    }, env.engine.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    while (this.running && this.inFlight.size < env.engine.concurrency) {
      const job = await claimNextJob(this.id);
      if (!job) return;

      const key = String(job._id);
      this.inFlight.set(key, job);
      void this.process(job).finally(() => this.inFlight.delete(key));
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    const runId = String(job.run);
    try {
      const result = await executeRun(runId, this.id);

      if (result.status === 'waiting' && result.resumeAt) {
        await deferJob(job, result.resumeAt);
        return;
      }

      /*
       * A workflow that failed is still a finished job. Retrying it here would
       * replay the run, which is how duplicate webhooks and spreadsheet rows
       * were being produced. Step-level retries (`retryOnFail`) are the correct
       * place to retry, because they retry one step rather than the whole graph.
       */
      await completeJob(job);
    } catch (error) {
      // Only genuine infrastructure faults reach here. Retrying is safe because
      // the run resumes from its persisted state rather than starting over.
      const message = toErrorMessage(error);
      logger.error({ runId, err: message }, 'Job execution threw');
      await failJob(job, message);
    }
  }
}

export const worker = new Worker();
