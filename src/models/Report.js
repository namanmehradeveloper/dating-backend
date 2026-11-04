// A member's report about another member, one of their photos or a message they sent.
// Moderators work through reports in the admin panel; every status change is kept in `history`.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const REPORT_REASONS = [
  'FAKE_PROFILE',
  'INAPPROPRIATE_PHOTOS',
  'HARASSMENT',
  'SPAM_OR_SCAM',
  'UNDERAGE',
  'OFFLINE_BEHAVIOUR',
  'OTHER',
];
export const REPORT_TARGET_TYPES = ['USER', 'PHOTO', 'MESSAGE'];
export const REPORT_STATUSES = ['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'];

const historyEntrySchema = new mongoose.Schema(
  {
    status: { type: String, enum: REPORT_STATUSES },
    actorId: String,
    note: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const reportSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('rep'),
    reporterId: { type: String, required: true },
    targetType: { type: String, enum: REPORT_TARGET_TYPES, required: true },
    targetId: { type: String, required: true },
    targetUserId: { type: String, required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: String,
    status: { type: String, enum: REPORT_STATUSES, default: 'OPEN' },
    assignedModeratorId: String,
    resolutionNote: String,
    resolvedAt: Date,
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ targetUserId: 1, createdAt: -1 });
reportSchema.index({ reporterId: 1, createdAt: -1 });

export const Report = mongoose.model('Report', reportSchema);
