import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const nodeSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    name: { type: String, required: true },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    params: { type: Schema.Types.Mixed, default: {} },
    disabled: { type: Boolean, default: false },
    notes: { type: String },
    onError: { type: String, enum: ['stop', 'continue'], default: 'stop' },
    retryOnFail: { type: Boolean, default: false },
    maxTries: { type: Number, default: 3 },
    waitBetweenTriesMs: { type: Number, default: 1000 },
  },
  { _id: false },
);

const edgeSchema = new Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    sourceHandle: { type: String, default: 'main' },
  },
  { _id: false },
);

const workflowSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    active: { type: Boolean, default: false, index: true },
    nodes: { type: [nodeSchema], default: [] },
    edges: { type: [edgeSchema], default: [] },
    /** Static values available to every node as {{ $vars.myKey }}. */
    variables: { type: Schema.Types.Mixed, default: {} },
    /** Stable public webhook path segment. Regenerating it invalidates old URLs. */
    webhookId: { type: String, unique: true, sparse: true, index: true },
    settings: {
      timezone: { type: String, default: 'UTC' },
      saveSuccessfulRunData: { type: Boolean, default: true },
      saveFailedRunData: { type: Boolean, default: true },
      timeoutMs: { type: Number, default: 300000 },
    },
    tags: { type: [String], default: [] },
    stats: {
      runs: { type: Number, default: 0 },
      success: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      lastRunAt: { type: Date },
      lastRunStatus: { type: String },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

workflowSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type WorkflowAttrs = InferSchemaType<typeof workflowSchema>;
export type WorkflowDoc = HydratedDocument<WorkflowAttrs>;

export const Workflow = model('Workflow', workflowSchema);
