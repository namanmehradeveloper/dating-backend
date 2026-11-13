// Erases accounts whose 14-day deletion grace period has ended. Runs hourly inside the API process.
// Reports and audit logs are kept as moderation records; everything else about the member is removed.

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

// Erases one member's data and account.
export async function eraseAccount(user) {
  const userId = user._id;
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
}

// Erases every account whose scheduled deletion date has passed. Returns how many were erased.
export async function purgeDueAccounts(now = new Date()) {
  const dueUsers = await User.find({ 'deletion.status': 'SCHEDULED', 'deletion.scheduledFor': { $lte: now } })
    .select('_id phoneNumber')
    .lean();
  for (const user of dueUsers) {
    await eraseAccount(user);
  }
  return dueUsers.length;
}

// Starts the hourly purge. The timer does not keep the process alive on shutdown.
export function startAccountDeletionJob() {
  const run = async () => {
    markJobStarted(JOB_ID);
    try {
      const count = await purgeDueAccounts();
      markJobSucceeded(JOB_ID, { erased: count });
      if (count > 0) logger.info('Erased accounts after the deletion grace period', { count });
    } catch (error) {
      markJobFailed(JOB_ID, error);
      logger.error('Account deletion job failed', { error: error.message });
    }
  };
  run();
  setInterval(run, RUN_EVERY_MS).unref();
}
