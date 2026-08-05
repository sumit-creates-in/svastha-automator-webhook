import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * MongoDB-backed job queue. Workers claim jobs with an atomic findOneAndUpdate,
 * so multiple server instances can share one collection without Redis.
 */
const jobSchema = new Schema(
  {
    run: { type: Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
    workflow: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'done', 'failed'],
      default: 'pending',
      index: true,
    },
    /** Earliest time this job may be picked up (used for delays and retries). */
    runAt: { type: Date, default: () => new Date(), index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lockedAt: { type: Date },
    lockedBy: { type: String },
    lastError: { type: String },
    priority: { type: Number, default: 0 },
  },
  { timestamps: true },
);

jobSchema.index({ status: 1, runAt: 1, priority: -1 });

export type JobAttrs = InferSchemaType<typeof jobSchema>;
export type JobDoc = HydratedDocument<JobAttrs>;

export const Job = model('Job', jobSchema);
