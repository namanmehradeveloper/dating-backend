// Admin profile management: list/stats, detail, audited edits, photo moderation,
// visibility/pause/snooze, boost, privacy, and review history.

import bcrypt from 'bcryptjs';
import { AuditLog } from '../../models/AuditLog.js';
import { Profile } from '../../models/Profile.js';
import { User } from '../../models/User.js';
import { calculateAge, latestBirthDateForAge, MINIMUM_AGE } from '../../utils/age.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildFileUrl } from '../../utils/fileUrls.js';
import { buildPage, encodeCursor, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { recordAudit } from '../audit.service.js';
import { BCRYPT_ROUNDS } from '../auth.service.js';
import { areKnownInterestIds, loadInterestLabels } from '../interest.service.js';
import { getEffectiveVisibility, isDiscoverableProfile } from '../profileVisibility.service.js';
import { revokeAllUserTokens } from '../token.service.js';
import { loadUserCards, presentContact, toUserCard } from './adminPresenter.js';

export { getEffectiveVisibility, isDiscoverableProfile };

const PROFILE_AUDIT_ACTIONS = [
  'PROFILE_PHOTO_REMOVED',
  'PROFILE_PHOTO_MODERATED',
  'PROFILE_UPDATED',
  'PROFILE_ACCOUNT_UPDATED',
  'PROFILE_VISIBILITY_CHANGED',
  'PROFILE_BOOST_CHANGED',
  'PROFILE_PRIVACY_CHANGED',
];

const MAX_COMPLETENESS = 5;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basicsToObject(basics) {
  if (!basics) return {};
  return basics instanceof Map ? Object.fromEntries(basics) : { ...basics };
}

// Completeness: displayName, photos, bio, interests, relationshipGoal (0–5).
export function completenessScore(profile) {
  let score = 0;
  if (profile.displayName) score += 1;
  if ((profile.photos ?? []).length > 0) score += 1;
  if (profile.bio) score += 1;
  if ((profile.interestIds ?? []).length > 0) score += 1;
  if (profile.relationshipGoal) score += 1;
  return score;
}

export function completenessBreakdown(profile) {
  return {
    displayName: Boolean(profile.displayName),
    photos: (profile.photos ?? []).length > 0,
    bio: Boolean(profile.bio),
    interests: (profile.interestIds ?? []).length > 0,
    relationshipGoal: Boolean(profile.relationshipGoal),
    score: completenessScore(profile),
    max: MAX_COMPLETENESS,
    percent: Math.round((completenessScore(profile) / MAX_COMPLETENESS) * 100),
  };
}

export function presentBoost(profile, now = new Date()) {
  const boost = profile.boost ?? {};
  if (!boost.active) {
    return { active: false, expiresAt: boost.expiresAt ?? null, activatedAt: boost.activatedAt ?? null, expired: false };
  }
  const expired = Boolean(boost.expiresAt && new Date(boost.expiresAt) <= now);
  return {
    active: !expired,
    expiresAt: boost.expiresAt ?? null,
    activatedAt: boost.activatedAt ?? null,
    expired,
  };
}

function presentPrivacy(profile) {
  const privacy = profile.privacy ?? {};
  return {
    showAge: privacy.showAge !== false,
    showDistance: privacy.showDistance !== false,
    showOnlineStatus: privacy.showOnlineStatus !== false,
    incognito: Boolean(privacy.incognito),
  };
}

function presentPhoto(photo) {
  return {
    id: photo._id,
    url: buildFileUrl(photo.relativePath),
    order: photo.order,
    moderationStatus: photo.moderationStatus ?? 'APPROVED',
    moderationReason: photo.moderationReason ?? null,
    moderatedAt: photo.moderatedAt ?? null,
    moderatedBy: photo.moderatedBy ?? null,
  };
}

function findPhoto(profile, photoId) {
  return profile.photos.id(photoId) ?? profile.photos.find((item) => String(item._id) === photoId);
}

async function buildSearchFilter(q) {
  if (isValidId(q)) return { userId: q };
  return { displayName: new RegExp(escapeRegex(q), 'i') };
}

function visibilityMatchFilter(visibility, now = new Date()) {
  if (!visibility) return {};
  if (visibility === 'VISIBLE') {
    return {
      $and: [
        {
          $or: [
            { visibilityStatus: { $in: ['VISIBLE', null] } },
            { visibilityStatus: { $exists: false } },
            { visibilityStatus: 'PAUSED', pausedUntil: { $lte: now } },
            { visibilityStatus: 'SNOOZED', snoozedUntil: { $lte: now } },
          ],
        },
        { $or: [{ 'privacy.incognito': { $ne: true } }, { privacy: { $exists: false } }] },
      ],
    };
  }
  if (visibility === 'HIDDEN') return { visibilityStatus: 'HIDDEN' };
  if (visibility === 'PAUSED') {
    return {
      visibilityStatus: 'PAUSED',
      $or: [{ pausedUntil: { $gt: now } }, { pausedUntil: null }, { pausedUntil: { $exists: false } }],
    };
  }
  if (visibility === 'SNOOZED') {
    return {
      visibilityStatus: 'SNOOZED',
      $or: [{ snoozedUntil: { $gt: now } }, { snoozedUntil: null }, { snoozedUntil: { $exists: false } }],
    };
  }
  return {};
}

async function buildListFilter(filters, now = new Date()) {
  const parts = [];
  if (filters.q) parts.push(await buildSearchFilter(filters.q));
  if (filters.gender) parts.push({ gender: filters.gender });
  if (filters.relationshipGoal) parts.push({ relationshipGoal: filters.relationshipGoal });
  if (filters.visibility) parts.push(visibilityMatchFilter(filters.visibility, now));
  if (filters.boostActive === 'true') {
    parts.push({ 'boost.active': true, $or: [{ 'boost.expiresAt': { $gt: now } }, { 'boost.expiresAt': null }] });
  } else if (filters.boostActive === 'false') {
    parts.push({
      $or: [
        { 'boost.active': { $ne: true } },
        { 'boost.active': true, 'boost.expiresAt': { $lte: now } },
      ],
    });
  }
  if (filters.photoModeration === 'PENDING') {
    parts.push({ photos: { $elemMatch: { moderationStatus: 'PENDING' } } });
  } else if (filters.photoModeration === 'REJECTED') {
    parts.push({ photos: { $elemMatch: { moderationStatus: 'REJECTED' } } });
  } else if (filters.photoModeration === 'HAS_PENDING') {
    parts.push({ photos: { $elemMatch: { moderationStatus: 'PENDING' } } });
  }
  if (filters.minCompleteness !== undefined || filters.maxCompleteness !== undefined) {
    // Completeness is computed in app code; filter after load when set.
  }
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

function matchesCompletenessFilter(profile, filters) {
  const score = completenessScore(profile);
  if (filters.minCompleteness !== undefined && score < filters.minCompleteness) return false;
  if (filters.maxCompleteness !== undefined && score > filters.maxCompleteness) return false;
  return true;
}

function summarizeListItem(profile, user, now) {
  const pendingPhotos = (profile.photos ?? []).filter((photo) => (photo.moderationStatus ?? 'APPROVED') === 'PENDING').length;
  const age = calculateAge(profile.dateOfBirth);
  return {
    ...(user ? toUserCard(user, profile) : { id: profile.userId, displayName: profile.displayName, photoUrl: null, role: null, status: null }),
    displayName: profile.displayName,
    photoCount: (profile.photos ?? []).length,
    pendingPhotoCount: pendingPhotos,
    completenessScore: completenessScore(profile),
    completenessPercent: Math.round((completenessScore(profile) / MAX_COMPLETENESS) * 100),
    bio: Boolean(profile.bio),
    hasInterests: (profile.interestIds ?? []).length > 0,
    hasGoal: Boolean(profile.relationshipGoal),
    hasPrompt: Boolean(profile.prompt?.promptId),
    gender: profile.gender ?? null,
    relationshipGoal: profile.relationshipGoal ?? null,
    visibilityStatus: getEffectiveVisibility(profile, now),
    boost: presentBoost(profile, now),
    age,
    ageEligible: age >= MINIMUM_AGE,
    verificationStatus: user?.verificationStatus ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// GET /admin/profiles/stats
export async function getProfileStats() {
  const now = new Date();
  const [
    total,
    incomplete,
    pendingPhotos,
    hidden,
    paused,
    snoozed,
    boosted,
    underage,
  ] = await Promise.all([
    Profile.countDocuments(),
    Profile.countDocuments({
      $or: [
        { bio: { $in: [null, ''] } },
        { bio: { $exists: false } },
        { interestIds: { $size: 0 } },
        { relationshipGoal: { $in: [null, ''] } },
        { relationshipGoal: { $exists: false } },
        { photos: { $size: 0 } },
      ],
    }),
    Profile.countDocuments({ photos: { $elemMatch: { moderationStatus: 'PENDING' } } }),
    Profile.countDocuments({ visibilityStatus: 'HIDDEN' }),
    Profile.countDocuments({
      visibilityStatus: 'PAUSED',
      $or: [{ pausedUntil: { $gt: now } }, { pausedUntil: null }, { pausedUntil: { $exists: false } }],
    }),
    Profile.countDocuments({
      visibilityStatus: 'SNOOZED',
      $or: [{ snoozedUntil: { $gt: now } }, { snoozedUntil: null }, { snoozedUntil: { $exists: false } }],
    }),
    Profile.countDocuments({
      'boost.active': true,
      $or: [{ 'boost.expiresAt': { $gt: now } }, { 'boost.expiresAt': null }],
    }),
    Profile.countDocuments({ dateOfBirth: { $gt: latestBirthDateForAge(MINIMUM_AGE - 1) } }),
  ]);

  return {
    total,
    incomplete,
    pendingPhotos,
    hidden,
    paused,
    snoozed,
    boosted,
    underage,
  };
}

// GET /admin/profiles — newest profiles first.
export async function listProfiles(filters, { limit, cursor }) {
  const now = new Date();
  const baseFilter = await buildListFilter(filters, now);
  const needsCompletenessFilter = filters.minCompleteness !== undefined || filters.maxCompleteness !== undefined;
  const fetchLimit = needsCompletenessFilter ? Math.min(Math.max(limit * 5, 40), 120) : limit;

  const docs = await Profile.find({ ...baseFilter, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(fetchLimit + 1)
    .lean();

  const matched = needsCompletenessFilter
    ? docs.filter((profile) => matchesCompletenessFilter(profile, filters))
    : docs;
  const pageItems = matched.slice(0, limit);
  const hasMore = matched.length > limit || docs.length > fetchLimit;
  const nextCursor =
    hasMore && pageItems.length > 0
      ? encodeCursor(pageItems[pageItems.length - 1].createdAt, pageItems[pageItems.length - 1]._id)
      : null;

  const users = await User.find({ _id: { $in: pageItems.map((profile) => profile.userId) } })
    .select('email role status verificationStatus')
    .lean();
  const userById = new Map(users.map((user) => [user._id, user]));

  return {
    items: pageItems.map((profile) => summarizeListItem(profile, userById.get(profile.userId), now)),
    nextCursor,
  };
}

// GET /admin/profiles/photo-queue — photos awaiting moderation.
export async function listPhotoQueue(filters, { limit, cursor }) {
  const status = filters.status ?? 'PENDING';
  const match = { photos: { $elemMatch: { moderationStatus: status } } };
  if (filters.q) Object.assign(match, await buildSearchFilter(filters.q));

  const docs = await Profile.find({ ...match, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((profile) => profile.userId));

  const items = [];
  for (const profile of page.items) {
    for (const photo of profile.photos ?? []) {
      if ((photo.moderationStatus ?? 'APPROVED') !== status) continue;
      items.push({
        photoId: photo._id,
        userId: profile.userId,
        user: cardFor(profile.userId),
        url: buildFileUrl(photo.relativePath),
        order: photo.order,
        moderationStatus: photo.moderationStatus ?? 'APPROVED',
        moderationReason: photo.moderationReason ?? null,
        profileCreatedAt: profile.createdAt,
      });
    }
  }

  return { items, nextCursor: page.nextCursor };
}

async function loadProfileOrThrow(userId) {
  const profile = await Profile.findOne({ userId });
  if (!profile) throw ApiError.notFound();
  return profile;
}

// GET /admin/profiles/:userId
export async function getProfile(viewerRole, userId) {
  const [profile, user] = await Promise.all([
    Profile.findOne({ userId }).lean(),
    User.findById(userId).select('email phoneNumber role status verificationStatus onboardingComplete lastActiveAt createdAt').lean(),
  ]);
  if (!profile || !user) throw ApiError.notFound();

  const interestLabels = await loadInterestLabels(profile.interestIds ?? []);
  const now = new Date();
  const age = calculateAge(profile.dateOfBirth);

  return {
    id: profile.userId,
    profileId: profile._id,
    ...presentContact(user, viewerRole),
    role: user.role,
    status: user.status,
    verificationStatus: user.verificationStatus,
    onboardingComplete: user.onboardingComplete,
    lastActiveAt: user.lastActiveAt ?? null,
    accountCreatedAt: user.createdAt,
    displayName: profile.displayName,
    dateOfBirth: profile.dateOfBirth,
    age,
    ageEligible: age >= MINIMUM_AGE,
    gender: profile.gender ?? null,
    showGender: Boolean(profile.showGender),
    relationshipGoal: profile.relationshipGoal ?? null,
    bio: profile.bio ?? null,
    prompt: profile.prompt?.promptId ? { promptId: profile.prompt.promptId, answer: profile.prompt.answer } : null,
    basics: basicsToObject(profile.basics),
    interestIds: profile.interestIds ?? [],
    interests: (profile.interestIds ?? []).map((id) => interestLabels.get(id)).filter(Boolean),
    city: profile.city ?? null,
    occupation: profile.occupation ?? null,
    preferences: {
      minAge: profile.preferences?.minAge ?? 18,
      maxAge: profile.preferences?.maxAge ?? 99,
      maxDistanceKm: profile.preferences?.maxDistanceKm ?? 80,
      showMe: profile.preferences?.showMe ?? 'EVERYONE',
    },
    photos: [...(profile.photos ?? [])].sort((a, b) => a.order - b.order).map(presentPhoto),
    completeness: completenessBreakdown(profile),
    visibilityStatus: getEffectiveVisibility(profile, now),
    visibilityStored: profile.visibilityStatus || 'VISIBLE',
    pausedUntil: profile.pausedUntil ?? null,
    snoozedUntil: profile.snoozedUntil ?? null,
    visibilityNote: profile.visibilityNote ?? null,
    boost: presentBoost(profile, now),
    privacy: presentPrivacy(profile),
    hasLocation: Boolean(profile.location?.coordinates?.length),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// GET /admin/profiles/:userId/history — audited profile actions for this member.
export async function getProfileHistory(userId, { limit, cursor }) {
  const profile = await Profile.findOne({ userId }).select('_id').lean();
  if (!profile) throw ApiError.notFound();

  const docs = await AuditLog.find({
    targetType: 'USER',
    targetId: userId,
    action: { $in: PROFILE_AUDIT_ACTIONS },
    ...getAfterCursorFilter(cursor),
  })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();

  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((log) => log.actorId));

  return {
    items: page.items.map((log) => ({
      id: log._id,
      action: log.action,
      actor: cardFor(log.actorId),
      actorRole: log.actorRole,
      metadata: log.metadata ?? {},
      createdAt: log.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
}

// PATCH /admin/profiles/:userId/account — change phone and/or password (audited; never logs the password).
export async function updateAccount(actor, userId, { reason, phoneNumber, password }) {
  const [profile, user] = await Promise.all([
    Profile.findOne({ userId }).lean(),
    User.findById(userId).select('+passwordHash'),
  ]);
  if (!profile || !user) throw ApiError.notFound();

  const before = {
    phoneNumber: user.phoneNumber ?? null,
    hasPassword: Boolean(user.passwordHash),
  };

  if (phoneNumber !== undefined) {
    if (phoneNumber.clear) {
      if (!user.email) {
        throw ApiError.validation([{ field: 'phoneNumber', reason: 'EMAIL_REQUIRED' }]);
      }
      user.phoneNumber = undefined;
    } else {
      const taken = await User.exists({ phoneNumber, _id: { $ne: userId } });
      if (taken) throw ApiError.conflict('This phone number is already in use.');
      user.phoneNumber = phoneNumber;
    }
  }

  if (password !== undefined) {
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  }

  await user.save();

  if (password !== undefined) {
    await revokeAllUserTokens(userId, 'PASSWORD_RESET');
  }

  await recordAudit(actor, {
    action: 'PROFILE_ACCOUNT_UPDATED',
    targetType: 'USER',
    targetId: userId,
    metadata: {
      reason,
      before,
      after: {
        phoneNumber: user.phoneNumber ?? null,
        hasPassword: Boolean(user.passwordHash),
        passwordChanged: password !== undefined,
      },
    },
  });

  return getProfile(actor.role, userId);
}

// PATCH /admin/profiles/:userId — audited field corrections.
export async function updateProfile(actor, userId, { reason, ...changes }) {
  const profile = await loadProfileOrThrow(userId);
  const before = {
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    city: profile.city ?? null,
    occupation: profile.occupation ?? null,
    relationshipGoal: profile.relationshipGoal ?? null,
    interestIds: [...(profile.interestIds ?? [])],
    prompt: profile.prompt?.promptId ? { promptId: profile.prompt.promptId, answer: profile.prompt.answer } : null,
    basics: basicsToObject(profile.basics),
  };

  if (changes.displayName !== undefined) profile.displayName = changes.displayName;
  if (changes.bio !== undefined) profile.bio = changes.bio.clear ? null : changes.bio.value;
  if (changes.city !== undefined) profile.city = changes.city.clear ? null : changes.city.value;
  if (changes.occupation !== undefined) profile.occupation = changes.occupation.clear ? null : changes.occupation.value;
  if (changes.relationshipGoal !== undefined) {
    profile.relationshipGoal = changes.relationshipGoal.clear ? null : changes.relationshipGoal;
  }
  if (changes.interestIds !== undefined) {
    if (changes.interestIds.length > 0 && !(await areKnownInterestIds(changes.interestIds))) {
      throw ApiError.validation([{ field: 'interestIds', reason: 'UNKNOWN_INTEREST' }]);
    }
    profile.interestIds = changes.interestIds;
  }
  if (changes.prompt !== undefined) {
    profile.prompt = changes.prompt.clear ? null : changes.prompt;
  }
  if (changes.basics !== undefined) {
    profile.basics = changes.basics.clear ? null : changes.basics;
  }

  await profile.save();

  const after = {
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    city: profile.city ?? null,
    occupation: profile.occupation ?? null,
    relationshipGoal: profile.relationshipGoal ?? null,
    interestIds: [...(profile.interestIds ?? [])],
    prompt: profile.prompt?.promptId ? { promptId: profile.prompt.promptId, answer: profile.prompt.answer } : null,
    basics: basicsToObject(profile.basics),
  };

  await recordAudit(actor, {
    action: 'PROFILE_UPDATED',
    targetType: 'USER',
    targetId: userId,
    metadata: { reason, before, after },
  });

  return getProfile(actor.role, userId);
}

// PATCH /admin/profiles/:userId/visibility
export async function updateVisibility(actor, userId, input) {
  const profile = await loadProfileOrThrow(userId);
  const before = {
    visibilityStatus: profile.visibilityStatus || 'VISIBLE',
    pausedUntil: profile.pausedUntil ?? null,
    snoozedUntil: profile.snoozedUntil ?? null,
    visibilityNote: profile.visibilityNote ?? null,
  };

  profile.visibilityStatus = input.visibilityStatus;
  if (input.visibilityStatus === 'PAUSED') {
    profile.pausedUntil = input.pausedUntil ?? null;
    profile.snoozedUntil = undefined;
  } else if (input.visibilityStatus === 'SNOOZED') {
    profile.snoozedUntil = input.snoozedUntil ?? null;
    profile.pausedUntil = undefined;
  } else {
    profile.pausedUntil = undefined;
    profile.snoozedUntil = undefined;
  }
  if (input.visibilityNote !== undefined) {
    profile.visibilityNote = input.visibilityNote.clear ? null : input.visibilityNote.value;
  }

  await profile.save();

  await recordAudit(actor, {
    action: 'PROFILE_VISIBILITY_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: {
      reason: input.reason,
      from: before,
      to: {
        visibilityStatus: profile.visibilityStatus,
        pausedUntil: profile.pausedUntil ?? null,
        snoozedUntil: profile.snoozedUntil ?? null,
        visibilityNote: profile.visibilityNote ?? null,
      },
    },
  });

  return getProfile(actor.role, userId);
}

// PATCH /admin/profiles/:userId/boost
export async function updateBoost(actor, userId, input) {
  const profile = await loadProfileOrThrow(userId);
  const before = presentBoost(profile);

  if (input.active) {
    profile.boost = {
      active: true,
      activatedAt: new Date(),
      expiresAt: input.expiresAt ?? null,
    };
  } else {
    profile.boost = {
      active: false,
      activatedAt: profile.boost?.activatedAt,
      expiresAt: profile.boost?.expiresAt,
    };
  }
  await profile.save();

  await recordAudit(actor, {
    action: 'PROFILE_BOOST_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: { reason: input.reason, from: before, to: presentBoost(profile) },
  });

  return getProfile(actor.role, userId);
}

// PATCH /admin/profiles/:userId/privacy
export async function updatePrivacy(actor, userId, input) {
  const profile = await loadProfileOrThrow(userId);
  const before = presentPrivacy(profile);
  const privacy = {
    showAge: input.showAge ?? before.showAge,
    showDistance: input.showDistance ?? before.showDistance,
    showOnlineStatus: input.showOnlineStatus ?? before.showOnlineStatus,
    incognito: input.incognito ?? before.incognito,
  };
  profile.privacy = privacy;
  await profile.save();

  await recordAudit(actor, {
    action: 'PROFILE_PRIVACY_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: { reason: input.reason, from: before, to: privacy },
  });

  return getProfile(actor.role, userId);
}

// PATCH /admin/profiles/:userId/photos/:photoId/moderation
export async function moderatePhoto(actor, userId, photoId, { status, reason }) {
  const profile = await loadProfileOrThrow(userId);
  const photo = findPhoto(profile, photoId);
  if (!photo) throw ApiError.notFound();

  const from = photo.moderationStatus ?? 'APPROVED';
  photo.moderationStatus = status;
  photo.moderationReason = reason;
  photo.moderatedAt = new Date();
  photo.moderatedBy = actor.id;
  await profile.save();

  await recordAudit(actor, {
    action: 'PROFILE_PHOTO_MODERATED',
    targetType: 'USER',
    targetId: userId,
    metadata: { photoId, from, to: status, reason },
  });

  return {
    photo: presentPhoto(photo),
    profile: await getProfile(actor.role, userId),
  };
}

// DELETE /admin/profiles/:userId/photos/:photoId — require reason; audit PROFILE_PHOTO_REMOVED.
export async function removeProfilePhoto(actor, userId, photoId, { reason }) {
  const profile = await loadProfileOrThrow(userId);
  const photo = findPhoto(profile, photoId);
  if (!photo) throw ApiError.notFound();

  const removed = { id: photo._id, relativePath: photo.relativePath, order: photo.order };
  profile.photos.pull(photo._id);
  await profile.save();

  await recordAudit(actor, {
    action: 'PROFILE_PHOTO_REMOVED',
    targetType: 'USER',
    targetId: userId,
    metadata: { photoId, reason, relativePath: removed.relativePath },
  });

  const cardFor = await loadUserCards([userId]);
  return {
    user: cardFor(userId),
    removedPhoto: { id: removed.id, url: buildFileUrl(removed.relativePath), order: removed.order },
    photoCount: profile.photos.length,
  };
}
