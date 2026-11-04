// Remembers the response to a request sent with an Idempotency-Key for 24 hours, so a retry
// with the same key and body gets the same answer instead of repeating the action.

import mongoose from 'mongoose';

const idempotencyRecordSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    key: { type: String, required: true },
    route: { type: String, required: true },
    requestFingerprint: { type: String, required: true },
    state: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], default: 'IN_PROGRESS' },
    responseStatus: Number,
    responseBody: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
