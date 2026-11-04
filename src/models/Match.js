// A mutual like between two members. `pairKey` is the two user ids sorted and joined,
// and its unique index guarantees at most one match per pair, even for simultaneous likes.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const MATCH_STATUSES = ['ACTIVE', 'ENDED'];
export const MATCH_END_REASONS = ['UNMATCH', 'BLOCK', 'MODERATION', 'ACCOUNT_DELETED', 'EXPIRED'];

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: MATCH_STATUSES, required: true },
    reason: String,
    actorId: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const matchSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('mat'),
    pairKey: { type: String, required: true },
    userIds: { type: [String], required: true },
    status: { type: String, enum: MATCH_STATUSES, default: 'ACTIVE' },
    conversationId: { type: String, required: true },
    matchedAt: { type: Date, default: Date.now },
    endedAt: Date,
    // Private: never sent to members (match:removed deliberately gives no reason).
    endedReason: { type: String, enum: MATCH_END_REASONS },
    endedBy: String,
    // Admin / algorithm metadata (safe to omit for older documents).
    algorithmVersion: { type: String, default: 'v1' },
    compatibilityScore: { type: Number, min: 0, max: 100 },
    expiresAt: Date,
    statusHistory: { type: [statusHistorySchema], default: [] },
  },
  { timestamps: true },
);

matchSchema.index({ pairKey: 1 }, { unique: true });
matchSchema.index({ userIds: 1, status: 1, matchedAt: -1 });
matchSchema.index({ matchedAt: -1, _id: -1 });
matchSchema.index({ status: 1, expiresAt: 1 });
matchSchema.index({ algorithmVersion: 1, matchedAt: -1 });

// Returns the canonical key for a pair of users, the same whichever user comes first.
export function buildPairKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

export const Match = mongoose.model('Match', matchSchema);
