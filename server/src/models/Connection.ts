import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Reusable, encrypted credential store. `type` maps to a connection definition in
 * `engine/connections.ts` so the UI can render the right form.
 */
const connectionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, index: true },
    /** AES-256-GCM ciphertext of the credential object. */
    data: { type: String, required: true, select: false },
    /** Non-secret fields safe to show in lists (e.g. smtp host, from address). */
    preview: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastTestedAt: { type: Date },
    lastTestOk: { type: Boolean },
    lastTestError: { type: String },
  },
  { timestamps: true },
);

connectionSchema.index({ name: 1, type: 1 }, { unique: true });

connectionSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.data;
    delete ret.__v;
    return ret;
  },
});

export type ConnectionAttrs = InferSchemaType<typeof connectionSchema>;
export type ConnectionDoc = HydratedDocument<ConnectionAttrs>;

export const Connection = model('Connection', connectionSchema);
