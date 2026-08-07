import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { env } from '../config/env';

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'success', 'error', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Once a run reaches one of these it must never execute again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['success', 'error', 'cancelled'];

export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as RunStatus);
}

const stepSchema = new Schema(
  {
    nodeId: String,
    nodeName: String,
    nodeType: String,
    status: { type: String, enum: ['success', 'error', 'skipped', 'stopped', 'waiting'] },
    input: Schema.Types.Mixed,
    output: Schema.Types.Mixed,
    error: String,
    logs: { type: [String], default: [] },
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    tries: { type: Number, default: 1 },
  },
  { _id: false },
);

const runSchema = new Schema(
  {
    workflow: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
    workflowName: String,
    status: { type: String, enum: RUN_STATUSES, default: 'queued', index: true },
    mode: { type: String, enum: ['webhook', 'schedule', 'manual', 'test'], default: 'manual' },
    trigger: {
      nodeId: String,
      nodeName: String,
      payload: Schema.Types.Mixed,
    },
    steps: { type: [stepSchema], default: [] },
    /**
     * Serialised engine state. Written after every step so that a run
     * interrupted by a crash, redeploy or container restart resumes exactly
     * where it stopped instead of replaying steps that already ran.
     */
    state: { type: Schema.Types.Mixed, select: false },
    /**
     * Execution lock. A run is a one-shot thing — these fields stop two workers
     * (or a worker and an inline webhook handler) executing it at the same time.
     */
    lockedBy: { type: String },
    lockedAt: { type: Date },
    error: String,
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    startedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    /**
     * Fingerprint of the incoming payload, used to ignore repeat deliveries from
     * senders that retry when they don't get a fast enough reply.
     */
    dedupeKey: { type: String, index: true, sparse: true },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

runSchema.index({ createdAt: -1 });
runSchema.index({ workflow: 1, createdAt: -1 });

// TTL cleanup of old run history (expiresAt is set when a run finishes).
runSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

runSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    delete ret.state;
    return ret;
  },
});

export function runExpiryDate(): Date | undefined {
  if (!env.retention.runDays) return undefined;
  return new Date(Date.now() + env.retention.runDays * 24 * 60 * 60 * 1000);
}

export type RunAttrs = InferSchemaType<typeof runSchema>;
export type RunDoc = HydratedDocument<RunAttrs>;

export const Run = model('Run', runSchema);
