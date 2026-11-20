// Admin Deletion Management: stats, filtered ledger lists, detail + related audits,
// safe Retry, admin Cancel, and Super Admin force purge.

import { AccountDeletionRecord } from '../../models/AccountDeletionRecord.js';
import { AuditLog } from '../../models/AuditLog.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { pickPageMeta, queryPage } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { eraseAccount } from '../../jobs/accountDeletion.job.js';
import {
  recordDeletionCancelled,
  reconcileScheduledLedgers,
} from '../accountDeletionLedger.service.js';
import { recordAudit } from '../audit.service.js';
import { assertNotLastActiveSuperAdmin } from '../rbac.service.js';
import { loadUserCards, maskEmail, maskPhone, presentContact } from './adminPresenter.js';

const DELETION_AUDIT_ACTIONS = [
  'USER_DELETION_SCHEDULED',
  'USER_DELETION_CANCELLED',
  'USER_DELETION_PURGED',
  'USER_DELETION_PURGE_FAILED',
  'USER_DELETION_PURGE_RETRIED',
  'USER_DELETION_FORCE_PURGED',
];

const CANCELLABLE_LEDGER_STATUSES = ['SCHEDULED', 'FAILED'];
const FORCE_PURGE_LEDGER_STATUSES = ['SCHEDULED', 'READY', 'FAILED'];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function remainingMs(scheduledFor, now = new Date()) {
  return new Date(scheduledFor).getTime() - now.getTime();
}

function presentRemaining(scheduledFor, now = new Date()) {
  const ms = remainingMs(scheduledFor, now);
  if (ms <= 0) {
    return { remainingMs: ms, remainingLabel: 'Due', isDue: true };
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0) {
    return {
      remainingMs: ms,
      remainingLabel: remHours > 0 ? `${days}d ${remHours}h` : `${days}d`,
      isDue: false,
    };
  }
  const minutes = Math.max(1, Math.ceil(ms / (60 * 1000)));
  if (hours > 0) {
    return { remainingMs: ms, remainingLabel: `${hours}h`, isDue: false };
  }
  return { remainingMs: ms, remainingLabel: `${minutes}m`, isDue: false };
}

function presentContactSnapshot(record, viewerRole) {
  const showFull = viewerRole === 'ADMIN' || viewerRole === 'SUPER_ADMIN';
  return {
    email: showFull ? (record.emailSnapshot ?? null) : maskEmail(record.emailSnapshot),
    phoneNumber: showFull ? (record.phoneSnapshot ?? null) : maskPhone(record.phoneSnapshot),
  };
}

function presentDeletionSummary(record, scheduledByCard, viewerRole, now = new Date()) {
  const remaining = presentRemaining(record.scheduledFor, now);
  return {
    id: record._id,
    userId: record.userId,
    displayName: record.displayNameSnapshot ?? 'Unknown member',
    ...presentContactSnapshot(record, viewerRole),
    status: record.status,
    source: record.source,
    reason: record.reason ?? null,
    feedback: record.feedback ?? null,
    scheduledBy: scheduledByCard,
    requestedAt: record.requestedAt,
    scheduledFor: record.scheduledFor,
    cancelledAt: record.cancelledAt ?? null,
    cancelReason: record.cancelReason ?? null,
    purgedAt: record.purgedAt ?? null,
    lastAttemptAt: record.lastAttemptAt ?? null,
    retryCount: record.retryCount ?? 0,
    lastError: record.lastError ?? null,
    attemptCount: record.attempts?.length ?? 0,
    ...remaining,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function tabFilter(tab, now = new Date()) {
  if (tab === 'scheduled') {
    return { status: 'SCHEDULED', scheduledFor: { $gt: now } };
  }
  if (tab === 'ready') {
    return {
      status: { $in: ['SCHEDULED', 'READY'] },
      scheduledFor: { $lte: now },
    };
  }
  if (tab === 'purged') {
    return { status: 'PURGED' };
  }
  if (tab === 'failed') {
    return { status: 'FAILED' };
  }
  return {};
}

function sortFieldForTab(tab) {
  if (tab === 'scheduled' || tab === 'ready') return 'scheduledFor';
  if (tab === 'purged') return 'purgedAt';
  if (tab === 'failed') return 'lastAttemptAt';
  return 'createdAt';
}

// GET /admin/deletion-management/stats
export async function getDeletionStats() {
  await reconcileScheduledLedgers();
  const now = new Date();
  const [scheduled, ready, purged, failed] = await Promise.all([
    AccountDeletionRecord.countDocuments({ status: 'SCHEDULED', scheduledFor: { $gt: now } }),
    AccountDeletionRecord.countDocuments({
      status: { $in: ['SCHEDULED', 'READY'] },
      scheduledFor: { $lte: now },
    }),
    AccountDeletionRecord.countDocuments({ status: 'PURGED' }),
    AccountDeletionRecord.countDocuments({ status: 'FAILED' }),
  ]);
  return {
    scheduled,
    readyToPurge: ready,
    successfullyPurged: purged,
    failedJobs: failed,
  };
}

// GET /admin/deletion-management?tab=&q=&source=&cursor=&limit=
export async function listDeletionRecords(filters, pagination, viewerRole) {
  await reconcileScheduledLedgers();
  const now = new Date();
  const tab = filters.tab || 'scheduled';
  const dateField = sortFieldForTab(tab);
  const query = { ...tabFilter(tab, now) };

  if (filters.source) query.source = filters.source;
  if (filters.q) {
    const pattern = new RegExp(escapeRegex(filters.q), 'i');
    if (isValidId(filters.q)) {
      query.$or = [{ userId: filters.q }, { _id: filters.q }];
    } else {
      query.$or = [
        { displayNameSnapshot: pattern },
        { emailSnapshot: pattern },
        { userId: pattern },
        { reason: pattern },
      ];
    }
  }

  const direction = tab === 'scheduled' ? 'asc' : 'desc';
  const { docs, ...meta } = await queryPage(AccountDeletionRecord, query, pagination, { dateField, direction });
  const adminIds = docs.map((row) => row.scheduledByAdminId).filter(Boolean);
  const cardFor = await loadUserCards(adminIds);

  return {
    items: docs.map((row) =>
      presentDeletionSummary(row, row.scheduledByAdminId ? cardFor(row.scheduledByAdminId) : null, viewerRole, now),
    ),
    ...pickPageMeta(meta),
  };
}

// GET /admin/deletion-management/:recordId
export async function getDeletionRecordDetail(recordId, viewerRole) {
  const record = await AccountDeletionRecord.findById(recordId).lean();
  if (!record) throw ApiError.notFound('Deletion record not found');

  const [cardFor, liveUser, audits] = await Promise.all([
    loadUserCards([record.scheduledByAdminId, ...record.attempts.map((attempt) => attempt.actorId)].filter(Boolean)),
    User.findById(record.userId).select('status deletion role email phoneNumber').lean(),
    AuditLog.find({
      targetId: record.userId,
      action: { $in: DELETION_AUDIT_ACTIONS },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const now = new Date();
  const summary = presentDeletionSummary(
    record,
    record.scheduledByAdminId ? cardFor(record.scheduledByAdminId) : null,
    viewerRole,
    now,
  );

  const liveScheduled = Boolean(liveUser) && liveUser.deletion?.status === 'SCHEDULED';
  const canRetry = record.status === 'FAILED' && liveScheduled;
  const canCancel = CANCELLABLE_LEDGER_STATUSES.includes(record.status) && liveScheduled;
  const canForcePurge =
    FORCE_PURGE_LEDGER_STATUSES.includes(record.status) && liveScheduled && viewerRole === 'SUPER_ADMIN';

  return {
    ...summary,
    liveAccount: liveUser
      ? {
          id: liveUser._id,
          status: liveUser.status,
          role: liveUser.role,
          deletionStatus: liveUser.deletion?.status ?? 'NONE',
          scheduledFor: liveUser.deletion?.scheduledFor ?? null,
          ...presentContact(liveUser, viewerRole),
        }
      : null,
    attempts: (record.attempts ?? []).map((attempt) => ({
      at: attempt.at,
      outcome: attempt.outcome,
      error: attempt.error ?? null,
      triggeredBy: attempt.triggeredBy,
      actor: attempt.actorId ? cardFor(attempt.actorId) : null,
    })),
    auditTrail: audits.map((log) => ({
      id: log._id,
      action: log.action,
      actorId: log.actorId,
      actorRole: log.actorRole,
      metadata: log.metadata ?? {},
      createdAt: log.createdAt,
    })),
    canRetry,
    canCancel,
    canForcePurge,
  };
}

// POST /admin/deletion-management/:recordId/retry — safe retry via eraseAccount for FAILED rows only.
export async function retryFailedDeletion(actor, recordId) {
  const record = await AccountDeletionRecord.findById(recordId).lean();
  if (!record) throw ApiError.notFound('Deletion record not found');
  if (record.status !== 'FAILED') {
    throw ApiError.conflict('Only failed purge records can be retried.');
  }

  const user = await User.findById(record.userId).select('_id phoneNumber deletion').lean();
  if (!user || user.deletion?.status !== 'SCHEDULED') {
    throw ApiError.conflict('Member is no longer scheduled for deletion; retry is not available.');
  }
  if (user.deletion.scheduledFor && new Date(user.deletion.scheduledFor) > new Date()) {
    throw ApiError.conflict('Grace period has not ended yet.');
  }

  await recordAudit(actor, {
    action: 'USER_DELETION_PURGE_RETRIED',
    targetType: 'USER',
    targetId: record.userId,
    metadata: { recordId, previousError: record.lastError ?? null, retryCount: (record.retryCount ?? 0) + 1 },
  });

  try {
    await eraseAccount(user, { triggeredBy: 'ADMIN_RETRY', actor: { id: actor.id, role: actor.role } });
  } catch (error) {
    if (error?.code === 'PURGE_LOCKED') {
      throw ApiError.conflict('Purge already in progress for this account.');
    }
    // Ledger already marked FAILED by eraseAccount; surface a stable API error.
    throw ApiError.server('Purge retry failed');
  }

  return getDeletionRecordDetail(recordId, actor.role);
}

// POST /admin/deletion-management/:recordId/cancel — admin cancels a scheduled (or failed) deletion.
// Does not change member login cancellation (auth.service.cancelPendingDeletion).
export async function cancelScheduledDeletion(actor, recordId) {
  const record = await AccountDeletionRecord.findById(recordId).lean();
  if (!record) throw ApiError.notFound('Deletion record not found');
  if (!CANCELLABLE_LEDGER_STATUSES.includes(record.status)) {
    throw ApiError.conflict('Only scheduled or failed deletion records can be cancelled.');
  }

  const user = await User.findById(record.userId).lean();
  if (!user || user.deletion?.status !== 'SCHEDULED') {
    throw ApiError.conflict('Account is no longer scheduled for deletion.');
  }
  if (actor.id === record.userId) {
    throw ApiError.forbidden('You cannot cancel deletion of your own account from here.');
  }

  await User.updateOne({ _id: record.userId }, { $set: { deletion: { status: 'NONE' } } });
  await recordDeletionCancelled(record.userId, { cancelReason: 'ADMIN' });

  await recordAudit(actor, {
    action: 'USER_DELETION_CANCELLED',
    targetType: 'USER',
    targetId: record.userId,
    metadata: {
      recordId,
      cancelReason: 'ADMIN',
      previousStatus: record.status,
      targetRole: user.role,
    },
  });

  return getDeletionRecordDetail(recordId, actor.role);
}

// POST /admin/deletion-management/:recordId/purge — Super Admin force-erases immediately (skips remaining grace).
export async function forcePurgeDeletion(actor, recordId, { confirm }) {
  if (actor.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only a Super Admin can force-purge an account.');
  }
  if (confirm !== true) {
    throw ApiError.validation([{ field: 'confirm', reason: 'REQUIRED' }]);
  }

  const record = await AccountDeletionRecord.findById(recordId).lean();
  if (!record) throw ApiError.notFound('Deletion record not found');
  if (!FORCE_PURGE_LEDGER_STATUSES.includes(record.status)) {
    throw ApiError.conflict('This deletion record cannot be force-purged.');
  }

  const user = await User.findById(record.userId).select('_id phoneNumber deletion role status').lean();
  if (!user || user.deletion?.status !== 'SCHEDULED') {
    throw ApiError.conflict('Account is no longer scheduled for deletion.');
  }
  if (actor.id === record.userId) {
    throw ApiError.forbidden('You cannot delete your own account.');
  }

  await assertNotLastActiveSuperAdmin(user, { actionLabel: 'force-purge', includeScheduledTarget: true });

  await recordAudit(actor, {
    action: 'USER_DELETION_FORCE_PURGED',
    targetType: 'USER',
    targetId: record.userId,
    metadata: {
      recordId,
      previousStatus: record.status,
      scheduledFor: user.deletion?.scheduledFor ?? record.scheduledFor,
      targetRole: user.role,
      graceBypassed: true,
    },
  });

  try {
    await eraseAccount(user, { triggeredBy: 'ADMIN_FORCE', actor: { id: actor.id, role: actor.role } });
  } catch (error) {
    if (error?.code === 'PURGE_LOCKED') {
      throw ApiError.conflict('Purge already in progress for this account.');
    }
    throw ApiError.server('Force purge failed');
  }

  return getDeletionRecordDetail(recordId, actor.role);
}
