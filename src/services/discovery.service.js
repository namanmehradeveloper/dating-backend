// The discovery feed: members who fit both people's preferences, newest profiles first.
// Excluded: yourself, anyone you already swiped or matched, blocks in either direction, and anyone
// banned, suspended, pending deletion or not onboarded.

import { Match } from '../models/Match.js';
import { Profile } from '../models/Profile.js';
import { Swipe } from '../models/Swipe.js';
import { User } from '../models/User.js';
import { calculateAge, earliestBirthDateForAge, latestBirthDateForAge } from '../utils/age.js';
import { ApiError } from '../utils/ApiError.js';
import { encodeCursor, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { isVisibleMember } from './accountStatus.service.js';
import { getBlockedUserIds } from './block.service.js';
import { distanceInKm, toPublicProfiles } from './profilePresenter.js';
import { isDiscoverableProfile } from './profileVisibility.service.js';

const EARTH_RADIUS_KM = 6378.1;
const MAX_SCAN_ROUNDS = 5;

// Which genders a "show me" choice includes (null = everyone).
const GENDER_FOR_SHOW_ME = { WOMEN: 'WOMAN', MEN: 'MAN', EVERYONE: null };
// Which "show me" choices include a member of this gender.
const SHOW_ME_ACCEPTING = { WOMAN: ['WOMEN', 'EVERYONE'], MAN: ['MEN', 'EVERYONE'], NON_BINARY: ['EVERYONE'] };

// Collects everyone the member must never see in discovery.
async function loadExcludedUserIds(userId) {
  const [swipedIds, matches, blockedIds] = await Promise.all([
    Swipe.distinct('targetUserId', { userId }),
    Match.find({ userIds: userId }).select('userIds').lean(),
    getBlockedUserIds(userId),
  ]);
  const matchedIds = matches.flatMap((match) => match.userIds);
  return [...new Set([userId, ...swipedIds, ...matchedIds, ...blockedIds])];
}

// Builds the MongoDB filter for candidates that match the viewer's preferences, and whose own
// preferences (gender and age) include the viewer.
function buildCandidateFilter(viewer, excludedIds, { minAge, maxAge, distanceKm }) {
  const viewerAge = calculateAge(viewer.dateOfBirth);
  const conditions = [
    { userId: { $nin: excludedIds } },
    { dateOfBirth: { $gte: earliestBirthDateForAge(maxAge), $lte: latestBirthDateForAge(minAge) } },
    { 'preferences.showMe': { $in: SHOW_ME_ACCEPTING[viewer.gender] ?? ['EVERYONE'] } },
    { 'preferences.minAge': { $lte: viewerAge } },
    { 'preferences.maxAge': { $gte: viewerAge } },
  ];

  const wantedGender = GENDER_FOR_SHOW_ME[viewer.preferences.showMe];
  if (wantedGender) conditions.push({ gender: wantedGender });

  // Members without a shared location are still shown; distance only applies when both shared one.
  if (viewer.location?.coordinates?.length) {
    conditions.push({
      $or: [
        { location: { $geoWithin: { $centerSphere: [viewer.location.coordinates, distanceKm / EARTH_RADIUS_KM] } } },
        { location: { $exists: false } },
      ],
    });
  }
  return { $and: conditions };
}

// Returns true when the candidate is visible and the viewer is within the candidate's own distance limit.
function isCandidateAcceptable(candidate, user, viewer) {
  if (!isVisibleMember(user)) return false;
  if (!isDiscoverableProfile(candidate)) return false;
  const distance = distanceInKm(viewer.location, candidate.location);
  return distance === null || distance <= candidate.preferences.maxDistanceKm;
}

// Returns one page of the discovery feed. Filters that need account data are checked after the query,
// so several batches may be read to fill a page; nextCursor continues after the last profile read.
export async function getDiscoveryFeed(userId, filters, { limit, cursor }) {
  const [viewer, viewerAccount] = await Promise.all([Profile.findOne({ userId }).lean(), User.findById(userId).lean()]);
  if (!viewer || !viewerAccount?.onboardingComplete) throw ApiError.conflict('Please finish setting up your profile first.');

  const searchFilters = {
    minAge: filters.minAge ?? viewer.preferences.minAge,
    maxAge: filters.maxAge ?? viewer.preferences.maxAge,
    distanceKm: filters.distanceKm ?? viewer.preferences.maxDistanceKm,
  };
  if (searchFilters.minAge > searchFilters.maxAge) {
    throw ApiError.validation([{ field: 'maxAge', reason: 'OUT_OF_RANGE' }]);
  }

  const baseFilter = buildCandidateFilter(viewer, await loadExcludedUserIds(userId), searchFilters);
  const accepted = [];
  const acceptedUsers = new Map();
  let scanCursor = cursor;
  let lastScanned = null;

  for (let round = 0; round < MAX_SCAN_ROUNDS && accepted.length < limit; round += 1) {
    const batch = await Profile.find({ ...baseFilter, ...getAfterCursorFilter(scanCursor) }).sort(getPageSort()).limit(limit).lean();
    if (batch.length === 0) break;

    const users = await User.find({ _id: { $in: batch.map((profile) => profile.userId) } }).lean();
    const usersById = new Map(users.map((user) => [user._id, user]));

    for (const candidate of batch) {
      lastScanned = candidate;
      const user = usersById.get(candidate.userId);
      if (isCandidateAcceptable(candidate, user, viewer)) {
        accepted.push(candidate);
        acceptedUsers.set(user._id, user);
      }
      if (accepted.length === limit) break;
    }
    scanCursor = { date: lastScanned.createdAt, id: lastScanned._id };
  }

  const items = await toPublicProfiles(accepted, acceptedUsers, viewer.location);
  const hasMore = lastScanned && (await Profile.exists({ ...baseFilter, ...getAfterCursorFilter(scanCursor) }));
  const nextCursor = hasMore ? encodeCursor(lastScanned.createdAt, lastScanned._id) : null;
  return { items, nextCursor };
}
