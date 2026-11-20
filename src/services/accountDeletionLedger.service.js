// Keeps AccountDeletionRecord in sync with User.deletion and purge outcomes.
// Does not schedule deletions — that remains account.service + User.deletion.

import { AccountDeletionRecord } from '../models/AccountDeletionRecord.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { recordAudit } from './audit.service.js';
import { logger } from '../utils/logger.js';

export const SYSTEM_DELETION_ACTOR = { id: 'system', role: 'SYSTEM' };
const PURGE_LOCK_MS = 2 * 60 * 1000;
const MAX_ERROR_LEN = 300;
const OPEN_STATUSES = ['SCHEDULED', 'READY', 'FAILED'];

function clipError(error) {
  const message = error?.message ? String(error.message) : String(error ?? 'Unknown error');
  return message.slice(0, MAX_ERROR_LEN);
}

async function loadSnapshot(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select('email phoneNumber').lean(),
    Profile.findOne({ userId }).select('displayName').lean(),
  ]);
  return {
    displayNameSnapshot: profile?.displayName ?? null,
    emailSnapshot: user?.email ?? null,
    phoneSnapshot: user?.phoneNumber ?? null,
  };
}

// Creates or refreshes the open ledger row when deletion is scheduled on User.deletion.
export async function recordDeletionScheduled(userId, { reason, feedback, scheduledFor, requestedAt, scheduledBy = null }) {
  const existing = await AccountDeletionRecord.findOne({ userId, status: { $in: OPEN_STATUSES } }).lean();
  if (existing) {
    return existing;
  }

  const snapshot = await loadSnapshot(userId);
  const source = scheduledBy?.id ? 'ADMIN' : 'MEMBER';
  const doc = await AccountDeletionRecord.create({
    userId,
    ...snapshot,
    status: 'SCHEDULED',
    source,
    reason: reason ?? null,
    feedback: feedback ?? null,
    scheduledByAdminId: scheduledBy?.id ?? null,
    scheduledByAdminRole: scheduledBy?.role ?? null,
    requestedAt: requestedAt ?? new Date(),
    scheduledFor,
  });
  return doc.toObject();
}

// Member signed in during the grace period — mirror User.deletion reset onto the ledger.
export async function recordDeletionCancelled(userId, { cancelReason = 'LOGIN' } = {}) {
  const updated = await AccountDeletionRecord.findOneAndUpdate(
    { userId, status: { $in: OPEN_STATUSES } },
    {
      $set: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason,
        purgeLockUntil: null,
        lastError: null,
      },
    },
    { returnDocument: 'after' },
  ).lean();
  return updated;
}

async function appendAttempt(recordId, attempt, extraSet = {}) {
  return AccountDeletionRecord.findOneAndUpdate(
    { _id: recordId },
    {
      $set: {
        lastAttemptAt: attempt.at,
        lastError: attempt.outcome === 'FAILED' ? attempt.error : null,
        purgeLockUntil: null,
        ...extraSet,
      },
      $push: { attempts: attempt },
      ...(attempt.triggeredBy === 'ADMIN_RETRY' ? { $inc: { retryCount: 1 } } : {}),
    },
    { returnDocument: 'after' },
  ).lean();
}

// Atomically claims an open ledger row for purge. Returns null when locked or missing.
export async function acquirePurgeLock(userId, { preferStatuses = OPEN_STATUSES } = {}) {
  const now = new Date();
  return AccountDeletionRecord.findOneAndUpdate(
    {
      userId,
      status: { $in: preferStatuses },
      $or: [{ purgeLockUntil: null }, { purgeLockUntil: { $lte: now } }],
    },
    {
      $set: {
        status: 'READY',
        purgeLockUntil: new Date(now.getTime() + PURGE_LOCK_MS),
        lastAttemptAt: now,
      },
    },
    { returnDocument: 'after' },
  ).lean();
}

export async function markDeletionPurged(recordId, { triggeredBy, actor = null }) {
  const at = new Date();
  const actorId = actor?.id ?? null;
  const attempt = {
    at,
    outcome: 'SUCCESS',
    error: null,
    triggeredBy,
    actorId,
  };
  const updated = await appendAttempt(recordId, attempt, {
    status: 'PURGED',
    purgedAt: at,
    lastError: null,
  });
  await recordAudit(actor ?? SYSTEM_DELETION_ACTOR, {
    action: 'USER_DELETION_PURGED',
    targetType: 'USER',
    targetId: updated?.userId,
    metadata: { recordId, triggeredBy, purgedAt: at },
  });
  return updated;
}

export async function markDeletionFailed(recordId, error, { triggeredBy, actor = null }) {
  const at = new Date();
  const clipped = clipError(error);
  const actorId = actor?.id ?? null;
  const attempt = {
    at,
    outcome: 'FAILED',
    error: clipped,
    triggeredBy,
    actorId,
  };
  const updated = await appendAttempt(recordId, attempt, {
    status: 'FAILED',
    lastError: clipped,
  });
  await recordAudit(actor ?? SYSTEM_DELETION_ACTOR, {
    action: 'USER_DELETION_PURGE_FAILED',
    targetType: 'USER',
    targetId: updated?.userId,
    metadata: { recordId, triggeredBy, error: clipped },
  });
  return updated;
}

// Backfills open ledger rows for accounts already on User.deletion SCHEDULED (pre-ledger data).
// Includes staff accounts scheduled by Super Admin as well as members.
export async function reconcileScheduledLedgers() {
  const users = await User.find({ 'deletion.status': 'SCHEDULED' })
    .select('_id email phoneNumber deletion role')
    .lean();
  if (users.length === 0) return 0;

  const userIds = users.map((user) => user._id);
  const existing = await AccountDeletionRecord.find({
    userId: { $in: userIds },
    status: { $in: OPEN_STATUSES },
  })
    .select('userId')
    .lean();
  const have = new Set(existing.map((row) => row.userId));
  const missing = users.filter((user) => !have.has(user._id));
  if (missing.length === 0) return 0;

  const profiles = await Profile.find({ userId: { $in: missing.map((user) => user._id) } })
    .select('userId displayName')
    .lean();
  const nameByUser = new Map(profiles.map((profile) => [profile.userId, profile.displayName]));

  const docs = missing.map((user) => {
    const feedback = user.deletion?.feedback ?? null;
    const adminScheduled = feedback === 'Scheduled by admin';
    return {
      userId: user._id,
      displayNameSnapshot: nameByUser.get(user._id) ?? null,
      emailSnapshot: user.email ?? null,
      phoneSnapshot: user.phoneNumber ?? null,
      status: 'SCHEDULED',
      source: adminScheduled ? 'ADMIN' : 'MEMBER',
      reason: user.deletion?.reason ?? null,
      feedback,
      scheduledByAdminId: null,
      scheduledByAdminRole: null,
      requestedAt: user.deletion?.requestedAt ?? user.deletion?.scheduledFor ?? new Date(),
      scheduledFor: user.deletion.scheduledFor,
    };
  });

  try {
    await AccountDeletionRecord.insertMany(docs, { ordered: false });
  } catch (error) {
    // Duplicate key from a concurrent reconcile is fine.
    if (error?.code !== 11000) logger.warn('Deletion ledger reconcile insert issue', { error: error.message });
  }
  return docs.length;
}

export function releasePurgeLock(recordId) {
  return AccountDeletionRecord.updateOne({ _id: recordId }, { $set: { purgeLockUntil: null } });
}
