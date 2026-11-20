// Durable history / monitoring ledger for account deletion. Live scheduling still lives on
// User.deletion; this collection records outcomes that survive User hard-delete.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const DELETION_RECORD_STATUSES = ['SCHEDULED', 'READY', 'PURGED', 'FAILED', 'CANCELLED'];
export const DELETION_SOURCES = ['MEMBER', 'ADMIN'];
export const DELETION_ATTEMPT_OUTCOMES = ['SUCCESS', 'FAILED'];
export const DELETION_ATTEMPT_TRIGGERS = ['JOB', 'ADMIN_RETRY', 'ADMIN_FORCE'];

const attemptSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    outcome: { type: String, enum: DELETION_ATTEMPT_OUTCOMES, required: true },
    error: { type: String, default: null },
    triggeredBy: { type: String, enum: DELETION_ATTEMPT_TRIGGERS, required: true },
    actorId: { type: String, default: null },
  },
  { _id: false },
);

const accountDeletionRecordSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('adr'),
    userId: { type: String, required: true },
    displayNameSnapshot: { type: String, default: null },
    emailSnapshot: { type: String, default: null },
    phoneSnapshot: { type: String, default: null },
    status: { type: String, enum: DELETION_RECORD_STATUSES, required: true, default: 'SCHEDULED' },
    source: { type: String, enum: DELETION_SOURCES, required: true },
    reason: { type: String, default: null },
    feedback: { type: String, default: null },
    scheduledByAdminId: { type: String, default: null },
    scheduledByAdminRole: { type: String, default: null },
    requestedAt: { type: Date, required: true },
    scheduledFor: { type: Date, required: true },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    purgedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null },
    attempts: { type: [attemptSchema], default: [] },
    // Prevents the hourly job and an admin Retry from erasing the same user concurrently.
    purgeLockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

accountDeletionRecordSchema.index({ status: 1, scheduledFor: 1, createdAt: -1 });
accountDeletionRecordSchema.index({ status: 1, createdAt: -1 });
accountDeletionRecordSchema.index({ scheduledFor: 1, status: 1 });
// At most one open ledger row per member (terminal statuses allow a later re-schedule).
accountDeletionRecordSchema.index(
  { userId: 1 },
  {
    unique: true,
    name: 'account_deletion_open_userId',
    partialFilterExpression: { status: { $in: ['SCHEDULED', 'READY', 'FAILED'] } },
  },
);
// Non-unique lookup for history rows (purged / cancelled).
accountDeletionRecordSchema.index({ userId: 1, createdAt: -1 }, { name: 'account_deletion_userId_createdAt' });

export const AccountDeletionRecord = mongoose.model('AccountDeletionRecord', accountDeletionRecordSchema);
