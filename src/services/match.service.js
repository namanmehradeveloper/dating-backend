// Matches: creating exactly one match (and one conversation) per pair, listing and ending them.
// Ending a match closes its conversation and tells both members with match:removed (no reason given).

import { Conversation } from '../models/Conversation.js';
import { buildPairKey, Match } from '../models/Match.js';
import { Profile } from '../models/Profile.js';
import { Swipe } from '../models/Swipe.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { newId } from '../utils/ids.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { isVisibleMember } from './accountStatus.service.js';
import { getBlockedUserIds, isBlockedEitherWay } from './block.service.js';
import { notifyUser } from './notification.service.js';
import { toPublicProfile, toPublicProfiles } from './profilePresenter.js';
import { emitToUser } from './realtime.service.js';
import { loadInterestLabels } from './interest.service.js';
import { getSetting } from './settings.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Shared-interest overlap score (0–100). Neutral 50 when neither profile has interests.
function computeCompatibilityScore(profileA, profileB) {
  const a = new Set(profileA?.interestIds ?? []);
  const b = profileB?.interestIds ?? [];
  if (a.size === 0 && b.length === 0) return 50;
  const shared = b.filter((id) => a.has(id)).length;
  const denom = Math.max(a.size, b.length, 1);
  return Math.min(100, Math.round((shared / denom) * 100));
}

// Returns the id of the other member in a match.
export function otherUserId(match, userId) {
  return match.userIds.find((id) => id !== userId);
}

// Shapes one match for one viewer: { id, otherUser, matchedAt, conversationId }.
function presentMatch(match, otherUser) {
  return { id: match._id, otherUser, matchedAt: match.matchedAt, conversationId: match.conversationId };
}

// Builds a match for the viewer, loading the other member's public profile.
export async function presentMatchFor(match, viewerId) {
  const otherId = otherUserId(match, viewerId);
  const [user, profile] = await Promise.all([User.findById(otherId).lean(), Profile.findOne({ userId: otherId }).lean()]);
  const labels = await loadInterestLabels(profile?.interestIds ?? []);
  return presentMatch(match, toPublicProfile(profile, user, { labels }));
}

// Inserts the match for a pair if it does not exist yet. The unique pairKey index makes this safe
// when both members like each other at the same moment. Returns { match, created }.
async function upsertMatch(userIdA, userIdB) {
  const pairKey = buildPairKey(userIdA, userIdB);
  const userIds = [userIdA, userIdB].sort();
  const [expiryDays, algoVersion, profiles] = await Promise.all([
    getSetting('matchExpiryDays'),
    getSetting('matchAlgorithmVersion'),
    Profile.find({ userId: { $in: [userIdA, userIdB] } }).lean(),
  ]);
  const byUser = new Map(profiles.map((profile) => [profile.userId, profile]));
  const now = new Date();
  const setOnInsert = {
    _id: newId('mat'),
    userIds,
    conversationId: newId('cnv'),
    status: 'ACTIVE',
    matchedAt: now,
    algorithmVersion: `v${algoVersion}`,
    compatibilityScore: computeCompatibilityScore(byUser.get(userIdA), byUser.get(userIdB)),
    statusHistory: [{ status: 'ACTIVE', at: now }],
  };
  if (expiryDays > 0) setOnInsert.expiresAt = new Date(now.getTime() + expiryDays * DAY_MS);

  try {
    const result = await Match.findOneAndUpdate(
      { pairKey },
      { $setOnInsert: setOnInsert },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    return { match: result.value, created: !result.lastErrorObject?.updatedExisting };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { match: await Match.findOne({ pairKey }), created: false };
  }
}

// Creates the conversation for a match if it is missing (also safe when called twice).
async function ensureConversation(match) {
  try {
    await Conversation.updateOne(
      { matchId: match._id },
      {
        $setOnInsert: {
          _id: match.conversationId,
          participantIds: match.userIds,
          status: 'ACTIVE',
          lastActivityAt: match.matchedAt,
          readStates: match.userIds.map((userId) => ({ userId, lastReadAt: match.matchedAt })),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

// Tells the other member about a new match (socket + notification) when both can still see each other.
async function announceNewMatch(match, swiperId) {
  const recipientId = otherUserId(match, swiperId);
  const [swiper, recipient] = await Promise.all([User.findById(swiperId), User.findById(recipientId)]);
  if (!isVisibleMember(swiper) || !isVisibleMember(recipient)) return;
  if (await isBlockedEitherWay(swiperId, recipientId)) return;

  emitToUser(recipientId, 'match:new', { match: await presentMatchFor(match, recipientId) });
  const notification = { type: 'NEW_MATCH', title: 'It\'s a match!', body: 'You have a new match. Say hello!', data: { matchId: match._id } };
  await Promise.all([notifyUser(recipientId, notification), notifyUser(swiperId, notification)]);
}

// Creates the match and conversation for a mutual like. Exactly one match and one conversation
// exist per pair however many requests race. Only the request that created the match announces it.
export async function createMatchForMutualLike(swiperId, targetUserId) {
  const { match, created } = await upsertMatch(swiperId, targetUserId);
  await ensureConversation(match);
  await Swipe.updateMany(
    { $or: [{ userId: swiperId, targetUserId }, { userId: targetUserId, targetUserId: swiperId }] },
    { $set: { matchId: match._id } },
  );
  if (created) await announceNewMatch(match, swiperId);
  return match;
}

// Ends an ACTIVE match whose expiresAt has passed (lazy expiry for member APIs).
export async function expireMatchIfNeeded(match) {
  if (!match || match.status !== 'ACTIVE' || !match.expiresAt) return match;
  if (new Date(match.expiresAt) > new Date()) return match;
  await endMatch(match, 'EXPIRED', null);
  return Match.findById(match._id);
}

// Lists the member's active matches, newest first, hiding blocked or hidden members.
export async function listMatches(userId, { limit, cursor }) {
  const blockedIds = await getBlockedUserIds(userId);
  const filter = { userIds: userId, status: 'ACTIVE', ...getAfterCursorFilter(cursor, 'matchedAt') };
  if (blockedIds.length > 0) filter.userIds = { $eq: userId, $nin: blockedIds };

  const docs = await Match.find(filter).sort(getPageSort('matchedAt')).limit(limit + 1).lean();
  const kept = [];
  for (const doc of docs) {
    const current = await expireMatchIfNeeded(doc);
    if (current?.status === 'ACTIVE') kept.push(current.toObject?.() ?? current);
  }
  const page = buildPage(kept, limit, 'matchedAt');

  const otherIds = page.items.map((match) => otherUserId(match, userId));
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: otherIds } }).lean(),
    Profile.find({ userId: { $in: otherIds } }).lean(),
  ]);
  const usersById = new Map(users.map((user) => [user._id, user]));
  const visibleProfiles = profiles.filter((profile) => isVisibleMember(usersById.get(profile.userId)));
  const publicProfiles = await toPublicProfiles(visibleProfiles, usersById);
  const profileByUserId = new Map(publicProfiles.map((profile) => [profile.id, profile]));

  const items = page.items
    .filter((match) => profileByUserId.has(otherUserId(match, userId)))
    .map((match) => presentMatch(match, profileByUserId.get(otherUserId(match, userId))));
  return { items, nextCursor: page.nextCursor };
}

// Loads an active match the member is part of, or 404 (also when the other member is hidden or blocked).
export async function findActiveMatchForUser(userId, matchId) {
  let match = await Match.findOne({ _id: matchId, userIds: userId, status: 'ACTIVE' });
  if (!match) throw ApiError.notFound();
  match = await expireMatchIfNeeded(match);
  if (!match || match.status !== 'ACTIVE') throw ApiError.notFound();

  const otherId = otherUserId(match, userId);
  const other = await User.findById(otherId);
  if (!isVisibleMember(other) || (await isBlockedEitherWay(userId, otherId))) throw ApiError.notFound();
  return match;
}

// Returns one active match to a participant.
export async function getMatch(userId, matchId) {
  const match = await findActiveMatchForUser(userId, matchId);
  return presentMatchFor(match, userId);
}

// Ends a match: closes the conversation and sends match:removed to both members (never the reason).
export async function endMatch(match, reason, endedBy) {
  const endedAt = new Date();
  const result = await Match.updateOne(
    { _id: match._id, status: 'ACTIVE' },
    {
      $set: { status: 'ENDED', endedAt, endedReason: reason, endedBy },
      $push: { statusHistory: { status: 'ENDED', reason, actorId: endedBy ?? undefined, at: endedAt } },
    },
  );
  await Conversation.updateOne({ matchId: match._id }, { $set: { status: 'CLOSED', closedAt: endedAt } });
  if (result.modifiedCount === 0) return;

  for (const userId of match.userIds) {
    emitToUser(userId, 'match:removed', { matchId: match._id, conversationId: match.conversationId });
  }
}

// Unmatches: ends the member's active match. The other member is not notified (only their list updates).
export async function unmatch(userId, matchId) {
  const match = await Match.findOne({ _id: matchId, userIds: userId, status: 'ACTIVE' });
  if (!match) throw ApiError.notFound();
  await endMatch(match, 'UNMATCH', userId);
}

// Ends the active match between two members, if there is one (used when blocking).
export async function endMatchBetween(userIdA, userIdB, reason, endedBy) {
  const match = await Match.findOne({ pairKey: buildPairKey(userIdA, userIdB), status: 'ACTIVE' });
  if (match) await endMatch(match, reason, endedBy);
}

// Ends every active match of a member (used for suspensions, bans and account deletion).
export async function endAllMatchesForUser(userId, reason, endedBy) {
  const matches = await Match.find({ userIds: userId, status: 'ACTIVE' });
  for (const match of matches) {
    await endMatch(match, reason, endedBy);
  }
}
