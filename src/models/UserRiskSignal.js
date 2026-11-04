// Rule-based fraud / abuse risk signals for a member. No third-party AI provider.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const RISK_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED'];

const signalSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    score: { type: Number, required: true },
    detail: String,
  },
  { _id: false },
);

const userRiskSignalSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('rsk'),
    userId: { type: String, required: true },
    signals: { type: [signalSchema], default: [] },
    totalScore: { type: Number, default: 0 },
    status: { type: String, enum: RISK_STATUSES, default: 'OPEN' },
    reviewedBy: String,
    reviewedAt: Date,
  },
  { timestamps: true },
);

userRiskSignalSchema.index({ userId: 1, createdAt: -1 });
userRiskSignalSchema.index({ status: 1, createdAt: -1 });
userRiskSignalSchema.index({ totalScore: -1 });

export const UserRiskSignal = mongoose.model('UserRiskSignal', userRiskSignalSchema);
