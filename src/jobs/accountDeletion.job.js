// Erases accounts whose 14-day deletion grace period has ended. Runs hourly inside the API process.
// Reports and audit logs are kept as moderation records; everything else about the member is removed.
// Per-user failures are isolated onto AccountDeletionRecord (FAILED) so one bad erase does not
// abort the rest of the batch; the next hourly run (or admin Retry) can try again.

import {
  Block,
  Device,
  IdempotencyRecord,
  Media,
  Message,
  Notification,
  NotificationPreference,
  OtpSession,
  PaymentTransaction,
  Profile,
  RefreshToken,
  SubscriptionEntitlement,
  SupportTicket,
  Swipe,
  User,
  VerificationRequest,
} from '../models/index.js';
import {
  acquirePurgeLock,
  markDeletionFailed,
  markDeletionPurged,
  recordDeletionScheduled,
  releasePurgeLock,
} from '../services/accountDeletionLedger.service.js';
import { endAllMatchesForUser } from '../services/match.service.js';
import { removeMediaFile } from '../services/media.service.js';
import { markJobFailed, markJobStarted, markJobSucceeded, registerJob } from '../services/jobRegistry.service.js';
import { logger } from '../utils/logger.js';

const RUN_EVERY_MS = 60 * 60 * 1000;
const JOB_ID = 'account-deletion-purge';

registerJob(JOB_ID, {
  name: 'Account deletion purge',
  schedule: 'Every 1 hour (in-process)',
});

// Removes every uploaded file of the member from Cloudinary or local disk.
async function deleteUserFiles(userId) {
  const media = await Media.find({ ownerId: userId }).select('relativePath publicId').lean();
  await Promise.all(media.map((item) => removeMediaFile(item)));
}

// Ensures a ledger row exists, then claims the purge lock. Returns null when another worker holds it.
async function claimLedgerForPurge(user) {
  await recordDeletionScheduled(user._id, {
    reason: user.deletion?.reason,
    feedback: user.deletion?.feedback,
    scheduledFor: user.deletion?.scheduledFor ?? new Date(),
    requestedAt: user.deletion?.requestedAt ?? new Date(),
    scheduledBy: null,
  });
  return acquirePurgeLock(user._id);
}

// Erases one member's data and account. Updates the deletion ledger to PURGED or FAILED.
export async function eraseAccount(user, { triggeredBy = 'JOB', actor = null } = {}) {
  const userId = user._id;
  const ledger = await claimLedgerForPurge(user);
  if (!ledger) {
    const err = new Error('Purge already in progress for this account');
    err.code = 'PURGE_LOCKED';
    throw err;
  }

  try {
    await endAllMatchesForUser(userId, 'ACCOUNT_DELETED', userId);
    await deleteUserFiles(userId);

    await Promise.all([
      Media.deleteMany({ ownerId: userId }),
      Profile.deleteMany({ userId }),
      Swipe.deleteMany({ $or: [{ userId }, { targetUserId: userId }] }),
      Block.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] }),
      Message.deleteMany({ senderId: userId }),
      Device.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      NotificationPreference.deleteMany({ userId }),
      RefreshToken.deleteMany({ userId }),
      SubscriptionEntitlement.deleteMany({ userId }),
      PaymentTransaction.deleteMany({ userId }),
      SupportTicket.deleteMany({ userId }),
      VerificationRequest.deleteMany({ userId }),
      IdempotencyRecord.deleteMany({ userId }),
      user.phoneNumber ? OtpSession.deleteMany({ phoneNumber: user.phoneNumber }) : null,
    ]);
    await User.deleteOne({ _id: userId, 'deletion.status': 'SCHEDULED' });
    await markDeletionPurged(ledger._id, { triggeredBy, actor });
  } catch (error) {
    if (error?.code !== 'PURGE_LOCKED') {
      await markDeletionFailed(ledger._id, error, { triggeredBy, actor });
    } else {
      await releasePurgeLock(ledger._id);
    }
    throw error;
  }
}

// Erases every due account. Returns { erased, failed }. Failures are per-user and do not stop the loop.
export async function purgeDueAccounts(now = new Date()) {
  const dueUsers = await User.find({ 'deletion.status': 'SCHEDULED', 'deletion.scheduledFor': { $lte: now } })
    .select('_id phoneNumber deletion')
    .lean();
  let erased = 0;
  let failed = 0;
  for (const user of dueUsers) {
    try {
      await eraseAccount(user, { triggeredBy: 'JOB' });
      erased += 1;
    } catch (error) {
      if (error?.code === 'PURGE_LOCKED') continue;
      failed += 1;
      logger.error('Failed to erase scheduled account', { userId: user._id, error: error.message });
    }
  }
  return { erased, failed, total: dueUsers.length };
}

// Starts the hourly purge. The timer does not keep the process alive on shutdown.
export function startAccountDeletionJob() {
  const run = async () => {
    markJobStarted(JOB_ID);
    try {
      const result = await purgeDueAccounts();
      const erased = typeof result === 'number' ? result : result.erased;
      markJobSucceeded(JOB_ID, result);
      if (erased > 0) logger.info('Erased accounts after the deletion grace period', result);
    } catch (error) {
      markJobFailed(JOB_ID, error);
      logger.error('Account deletion job failed', { error: error.message });
    }
  };
  run();
  setInterval(run, RUN_EVERY_MS).unref();
}
