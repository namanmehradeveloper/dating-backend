// Account deletion and data export. Deletion hides the member at once and erases their data
// after a 14-day grace period (jobs/accountDeletion.job.js); signing in again cancels it.

import { SubscriptionEntitlement } from '../models/SubscriptionEntitlement.js';
import { User } from '../models/User.js';
import { recordDeletionScheduled } from './accountDeletionLedger.service.js';
import { endUserSockets } from './realtime.service.js';
import { presentEntitlement } from './subscription.service.js';
import { revokeAllUserTokens } from './token.service.js';

export const DELETION_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Returns true when the member pays through a store subscription that will keep renewing,
// so the app must tell them to cancel it in the App Store or Play Store.
async function hasActiveStoreSubscription(userId) {
  const entitlement = presentEntitlement(await SubscriptionEntitlement.findOne({ userId }).lean());
  return entitlement.isActive && entitlement.willRenew && Boolean(entitlement.platform);
}

// Schedules deletion (idempotent: a repeated request keeps the first date), signs the member out
// everywhere and returns { status, scheduledFor, activeStoreSubscription }.
// Optional `scheduledBy: { id, role }` marks an admin-initiated schedule on the ledger.
export async function requestDeletion(userId, { reason, feedback, scheduledBy = null }) {
  const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
  const requestedAt = new Date();
  const updated = await User.updateOne(
    { _id: userId, 'deletion.status': { $ne: 'SCHEDULED' } },
    { $set: { deletion: { status: 'SCHEDULED', requestedAt, scheduledFor, reason, feedback } } },
  );
  const user = await User.findById(userId).select('deletion').lean();

  // Ledger mirrors the live schedule (including the first successful schedule only).
  if (updated.modifiedCount > 0 || user?.deletion?.status === 'SCHEDULED') {
    await recordDeletionScheduled(userId, {
      reason,
      feedback,
      scheduledFor: user.deletion.scheduledFor,
      requestedAt: user.deletion.requestedAt ?? requestedAt,
      scheduledBy: updated.modifiedCount > 0 ? scheduledBy : null,
    });
  }

  await revokeAllUserTokens(userId, 'ACCOUNT_DELETED');
  endUserSockets(userId);

  return {
    status: 'SCHEDULED',
    scheduledFor: user.deletion.scheduledFor,
    activeStoreSubscription: await hasActiveStoreSubscription(userId),
  };
}

// Data export is not built yet, so there is never an export in progress.
export function getExportStatus() {
  return { status: 'NONE' };
}
