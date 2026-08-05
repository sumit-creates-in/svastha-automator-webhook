import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Tracks the next fire time for every schedule/cron trigger node so multiple
 * instances never double-fire the same tick.
 */
const scheduleStateSchema = new Schema(
  {
    workflow: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
    nodeId: { type: String, required: true },
    expression: { type: String, required: true },
    timezone: { type: String, default: 'UTC' },
    nextRunAt: { type: Date, required: true, index: true },
    lastRunAt: { type: Date },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

scheduleStateSchema.index({ workflow: 1, nodeId: 1 }, { unique: true });

export type ScheduleStateAttrs = InferSchemaType<typeof scheduleStateSchema>;
export type ScheduleStateDoc = HydratedDocument<ScheduleStateAttrs>;

export const ScheduleState = model('ScheduleState', scheduleStateSchema);
