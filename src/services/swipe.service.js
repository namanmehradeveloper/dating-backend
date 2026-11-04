// Swipes (LIKE / PASS / SUPER_LIKE), free daily quotas, undo, and the likes lists.

import { LIKE_ACTIONS, Swipe } from '../models/Swipe.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { filterVisibleUserIds } from './accountStatus.service.js';
import { getBlockedUserIds } from './block.service.js';
import { createMatchForMutualLike, presentMatchFor } from './match.service.js';
import { notifyUser } from './notification.service.js';
import { findVisibleMember } from './profile.service.js';
import { toPublicProfiles, toSinglePublicProfile } from './profilePresenter.js';
import { getSetting } from './settings.service.js';
import { isPremium } from './subscription.service.js';

const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

// Throws SUBSCRIPTION_REQUIRED when a free member has used today's likes or super-likes.
async function assertSwipeQuota(userId, action) {
  if (action === 'PASS' || (await isPremium(userId))) return;

  const isSuperLike = action === 'SUPER_LIKE';
  const limit = await getSetting(isSuperLike ? 'freeDailySuperLikes' : 'freeDailyLikes');
  const usedToday = await Swipe.countDocuments({
    userId,
    action,
    createdAt: { $gte: new Date(Date.now() - QUOTA_WINDOW_MS) },
  });

  if (usedToday >= limit) {
    const reason = isSuperLike ? 'DAILY_SUPER_LIKES_EXHAUSTED' : 'DAILY_LIKES_EXHAUSTED';
    throw new ApiError('SUBSCRIPTION_REQUIRED', { details: [{ field: 'quota', reason }] });
  }
}

// Saves the swipe. Responding to the same member twice is 409 CONFLICT.
async function saveSwipe(userId, targetUserId, action) {
  try {
    return await Swipe.create({ userId, targetUserId, action });
  } catch (error) {
    if (error?.code === 11000) throw ApiError.conflict('You already responded to this profile.');
    throw error;
  }
}

// Records a swipe. A like back from the target creates the match and conversation in the same request.
export async function recordSwipe(userId, { targetUserId, action }) {
  if (targetUserId === userId) throw ApiError.validation([{ field: 'targetUserId', reason: 'INVALID' }]);
  await findVisibleMember(userId, targetUserId);
  await assertSwipeQuota(userId, action);

  const swipe = await saveSwipe(userId, targetUserId, action);
  if (!LIKE_ACTIONS.includes(action)) return { swipeId: swipe._id, isMatch: false, match: null };

  const likedBack = await Swipe.exists({ userId: targetUserId, targetUserId: userId, action: { $in: LIKE_ACTIONS } });
  if (!likedBack) {
    await notifyUser(targetUserId, { type: 'NEW_LIKE', title: 'Someone likes you', body: 'Someone new liked your profile.' });
    return { swipeId: swipe._id, isMatch: false, match: null };
  }

  const match = await createMatchForMutualLike(userId, targetUserId);
  return { swipeId: swipe._id, isMatch: true, match: await presentMatchFor(match, userId) };
}

// Free rewind quota: premium is unlimited; free members need freeDailyRewinds > 0 and unused slots.
async function assertRewindEntitlement(userId) {
  if (await isPremium(userId)) return;
  const freeRewinds = await getSetting('freeDailyRewinds');
  if (!freeRewinds) {
    throw new ApiError('SUBSCRIPTION_REQUIRED', { details: [{ field: 'entitlement', reason: 'UNDO_REQUIRES_PLUS' }] });
  }
  const user = await User.findById(userId).select('rewindQuota');
  const windowStart = new Date(Date.now() - QUOTA_WINDOW_MS);
  const used =
    user?.rewindQuota?.windowStartedAt && new Date(user.rewindQuota.windowStartedAt) >= windowStart
      ? user.rewindQuota.used ?? 0
      : 0;
  if (used >= freeRewinds) {
    throw new ApiError('SUBSCRIPTION_REQUIRED', { details: [{ field: 'quota', reason: 'DAILY_REWINDS_EXHAUSTED' }] });
  }
}

async function consumeRewindQuota(userId) {
  if (await isPremium(userId)) return;
  const user = await User.findById(userId).select('rewindQuota');
  const windowStart = new Date(Date.now() - QUOTA_WINDOW_MS);
  const inWindow = user?.rewindQuota?.windowStartedAt && new Date(user.rewindQuota.windowStartedAt) >= windowStart;
  const used = inWindow ? (user.rewindQuota.used ?? 0) + 1 : 1;
  const startedAt = inWindow ? user.rewindQuota.windowStartedAt : new Date();
  await User.updateOne({ _id: userId }, { $set: { rewindQuota: { used, windowStartedAt: startedAt } } });
}

// Undoes the member's most recent swipe (premium, or free when freeDailyRewinds > 0).
// Swipes that created a match cannot be undone.
export async function undoLastSwipe(userId) {
  await assertRewindEntitlement(userId);

  const lastSwipe = await Swipe.findOne({ userId }).sort({ createdAt: -1, _id: -1 });
  if (!lastSwipe) throw ApiError.notFound('There is nothing to undo.');
  if (lastSwipe.matchId) throw ApiError.conflict('This swipe created a match. Unmatch instead.');

  await Swipe.deleteOne({ _id: lastSwipe._id });
  await consumeRewindQuota(userId);

  try {
    const { user, profile } = await findVisibleMember(userId, lastSwipe.targetUserId);
    const viewer = await Profile.findOne({ userId }).select('location').lean();
    return { restoredProfile: await toSinglePublicProfile(profile, user, viewer?.location ?? null) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') return { restoredProfile: null };
    throw error;
  }
}

// Returns the ids of likers/likees that the member may see (visible and not blocked either way).
async function visibleCounterpartIds(userId, swipes, counterpartField) {
  const blockedIds = new Set(await getBlockedUserIds(userId));
  const candidateIds = [...new Set(swipes.map((swipe) => swipe[counterpartField]))].filter((id) => !blockedIds.has(id));
  return filterVisibleUserIds(candidateIds);
}

// Turns a page of swipes into { user, action, likedAt } items.
async function presentLikes(swipes, counterpartField) {
  const userIds = swipes.map((swipe) => swipe[counterpartField]);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: userIds } }).lean(),
    Profile.find({ userId: { $in: userIds } }).lean(),
  ]);
  const usersById = new Map(users.map((user) => [user._id, user]));
  const publicProfiles = await toPublicProfiles(profiles, usersById);
  const profileById = new Map(publicProfiles.map((profile) => [profile.id, profile]));

  return swipes
    .filter((swipe) => profileById.has(swipe[counterpartField]))
    .map((swipe) => ({ user: profileById.get(swipe[counterpartField]), action: swipe.action, likedAt: swipe.createdAt }));
}

// People who liked the member and are still waiting for an answer. Free members only see the count
// (403 SUBSCRIPTION_REQUIRED with reason COUNT_<n>) so the paywall can show it.
export async function listReceivedLikes(userId, { limit, cursor }) {
  const answeredIds = await Swipe.distinct('targetUserId', { userId });
  const pending = await Swipe.find({ targetUserId: userId, action: { $in: LIKE_ACTIONS }, userId: { $nin: answeredIds } })
    .select('userId')
    .lean();
  const visibleIds = await visibleCounterpartIds(userId, pending, 'userId');

  if (!(await isPremium(userId))) {
    throw new ApiError('SUBSCRIPTION_REQUIRED', { details: [{ field: 'likes', reason: `COUNT_${visibleIds.length}` }] });
  }

  const filter = { targetUserId: userId, action: { $in: LIKE_ACTIONS }, userId: { $in: visibleIds }, ...getAfterCursorFilter(cursor) };
  const docs = await Swipe.find(filter).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: await presentLikes(page.items, 'userId'), nextCursor: page.nextCursor };
}

// The member's likes that have not turned into a match yet.
export async function listSentLikes(userId, { limit, cursor }) {
  const pending = await Swipe.find({ userId, action: { $in: LIKE_ACTIONS }, matchId: null }).select('targetUserId').lean();
  const visibleIds = await visibleCounterpartIds(userId, pending, 'targetUserId');

  const filter = { userId, action: { $in: LIKE_ACTIONS }, matchId: null, targetUserId: { $in: visibleIds }, ...getAfterCursorFilter(cursor) };
  const docs = await Swipe.find(filter).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: await presentLikes(page.items, 'targetUserId'), nextCursor: page.nextCursor };
}
