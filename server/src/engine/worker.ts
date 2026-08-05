import crypto from 'node:crypto';
import { env } from '../config/env';
import { toErrorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { executeRun } from './executor';
import { claimNextJob, completeJob, deferJob, failJob, reclaimStalledJobs } from './queue';

/**
 * Polls the MongoDB job queue and executes runs. Multiple instances can run
 * safely - jobs are claimed atomically.
 */
export class Worker {
  private readonly id = `${process.env.RAILWAY_REPLICA_ID ?? 'local'}-${crypto.randomBytes(4).toString('hex')}`;
  private running = false;
  private inFlight = 0;
  private timer?: NodeJS.Timeout;
  private reclaimTimer?: NodeJS.Timeout;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ workerId: this.id, concurrency: env.engine.concurrency }, 'Engine worker started');
    this.loop();
    this.reclaimTimer = setInterval(() => {
      reclaimStalledJobs()
        .then((count) => {
          if (count > 0) logger.warn({ count }, 'Reclaimed stalled jobs');
        })
        .catch((error) => logger.error({ err: toErrorMessage(error) }, 'Reclaim failed'));
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    // Give in-flight runs a moment to persist their state.
    const deadline = Date.now() + 10_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
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
    while (this.running && this.inFlight < env.engine.concurrency) {
      const job = await claimNextJob(this.id);
      if (!job) return;

      this.inFlight += 1;
      void this.process(job).finally(() => {
        this.inFlight -= 1;
      });
    }
  }

  private async process(job: Awaited<ReturnType<typeof claimNextJob>>): Promise<void> {
    if (!job) return;
    const runId = String(job.run);
    try {
      const result = await executeRun(runId);
      if (result.status === 'waiting' && result.resumeAt) {
        await deferJob(job, result.resumeAt);
        return;
      }
      await completeJob(job);
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error({ runId, err: message }, 'Job execution threw');
      await failJob(job, message);
    }
  }
}

export const worker = new Worker();
