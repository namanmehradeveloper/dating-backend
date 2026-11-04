// Rules about whether an account may use the app, shared by sign-in, auth middleware and sockets.

import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

// Returns true while a suspension is in force (no end date, or the end date is still in the future).
export function isSuspensionActive(user) {
  if (user.status !== 'SUSPENDED') return false;
  return !user.suspendedUntil || new Date(user.suspendedUntil) > new Date();
}

// Returns true when the account must not use the app (banned, or currently suspended).
export function isAccountLocked(user) {
  return user.status === 'BANNED' || isSuspensionActive(user);
}

// Turns a finished suspension back into ACTIVE so the member can use the app again.
export async function liftExpiredSuspension(user) {
  if (user.status !== 'SUSPENDED' || isSuspensionActive(user)) return user;

  await User.updateOne(
    { _id: user._id, status: 'SUSPENDED' },
    { $set: { status: 'ACTIVE' }, $unset: { suspendedUntil: 1, statusReason: 1 } },
  );
  user.status = 'ACTIVE';
  user.suspendedUntil = undefined;
  return user;
}

// Throws 403 ACCOUNT_INELIGIBLE when the account is banned or suspended.
export async function assertAccountUsable(user) {
  await liftExpiredSuspension(user);
  if (isAccountLocked(user)) throw new ApiError('ACCOUNT_INELIGIBLE');
}

// Returns true when other members may see this account (active, onboarded, not pending deletion).
export function isVisibleMember(user) {
  return Boolean(user) && user.onboardingComplete && !isAccountLocked(user) && user.deletion?.status !== 'SCHEDULED';
}

// The same rule as isVisibleMember, written as a MongoDB filter for User queries.
export function visibleUserFilter() {
  return {
    onboardingComplete: true,
    'deletion.status': { $ne: 'SCHEDULED' },
    $or: [{ status: { $in: ['ACTIVE', 'WARNED'] } }, { status: 'SUSPENDED', suspendedUntil: { $lte: new Date() } }],
  };
}

// Returns the subset of `userIds` that other members may currently see.
export async function filterVisibleUserIds(userIds) {
  if (userIds.length === 0) return [];
  const visible = await User.find({ _id: { $in: userIds }, ...visibleUserFilter() }).select('_id').lean();
  return visible.map((user) => user._id);
}
