// Profile business logic: onboarding, reading and editing your own profile, preferences, interests,
// and reading other members' public profiles (respecting blocks and account status).

import { env } from '../config/env.js';
import { Media } from '../models/Media.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { calculateAge, MINIMUM_AGE } from '../utils/age.js';
import { ApiError } from '../utils/ApiError.js';
import { isVisibleMember } from './accountStatus.service.js';
import { isBlockedEitherWay } from './block.service.js';
import { areKnownInterestIds, resolveInterestIds } from './interest.service.js';
import { toMyProfile, toSinglePublicProfile } from './profilePresenter.js';
import { isDiscoverableProfile } from './profileVisibility.service.js';

// Loads the signed-in user and their profile (the profile may not exist before onboarding).
async function loadOwnAccount(userId) {
  const [user, profile] = await Promise.all([User.findById(userId), Profile.findOne({ userId })]);
  if (!user) throw ApiError.unauthenticated();
  return { user, profile };
}

// Loads the profile of an onboarded member, or answers 409 when onboarding is not finished.
async function loadOnboardedAccount(userId) {
  const account = await loadOwnAccount(userId);
  if (!account.user.onboardingComplete || !account.profile) {
    throw ApiError.conflict('Please finish setting up your profile first.');
  }
  return account;
}

// Returns MyProfile for the signed-in member.
export async function getMyProfile(userId) {
  const { user, profile } = await loadOwnAccount(userId);
  return toMyProfile(user, profile);
}

// Loads the onboarding photos in the order given. Only the member's own, approved PROFILE_PHOTO
// uploads are accepted; anything else is UNKNOWN_MEDIA.
async function loadOnboardingPhotos(userId, mediaIds) {
  const media = await Media.find({ _id: { $in: mediaIds }, ownerId: userId, purpose: 'PROFILE_PHOTO', status: 'APPROVED' });
  if (media.length !== mediaIds.length) return null;

  const byId = new Map(media.map((item) => [item._id, item]));
  return mediaIds.map((mediaId, order) => ({
    mediaId,
    relativePath: byId.get(mediaId).relativePath,
    order,
    moderationStatus: 'APPROVED',
  }));
}

// Checks the parts of onboarding that need the database (Terms version, interests, photos).
async function checkOnboardingReferences(userId, input) {
  const details = [];
  if (input.acceptedTermsVersion !== env.currentTermsVersion) {
    details.push({ field: 'acceptedTermsVersion', reason: 'NOT_CURRENT' });
  }

  if (!(await areKnownInterestIds(input.interestIds))) {
    details.push({ field: 'interestIds', reason: 'UNKNOWN_INTEREST' });
  }

  const photos = await loadOnboardingPhotos(userId, input.photoMediaIds);
  if (!photos) details.push({ field: 'photoMediaIds', reason: 'UNKNOWN_MEDIA' });

  if (details.length > 0) throw ApiError.validation(details);
  return photos;
}

// Creates the member's profile from the onboarding answers and marks onboarding complete.
// The server-side age check is authoritative: under 18 gets 403 ACCOUNT_INELIGIBLE.
export async function completeOnboarding(userId, input) {
  const { user } = await loadOwnAccount(userId);
  if (user.onboardingComplete) throw ApiError.conflict('Your profile is already set up.');

  const photos = await checkOnboardingReferences(userId, input);
  if (calculateAge(input.dateOfBirth) < MINIMUM_AGE) throw new ApiError('ACCOUNT_INELIGIBLE');

  const profileFields = {
    displayName: input.displayName,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    showGender: input.showGender,
    relationshipGoal: input.relationshipGoal,
    basics: input.basics,
    bio: input.bio,
    prompt: input.prompt,
    interestIds: input.interestIds,
    photos,
    location: input.location,
    preferences: { minAge: 18, maxAge: 99, maxDistanceKm: input.maxDistanceKm, showMe: input.showMe },
    acceptedTermsVersion: input.acceptedTermsVersion,
    acceptedTermsAt: new Date(),
  };

  await Profile.findOneAndUpdate({ userId }, { $set: profileFields }, { upsert: true });

  const result = await User.updateOne({ _id: userId, onboardingComplete: false }, { $set: { onboardingComplete: true } });
  if (result.modifiedCount === 0) throw ApiError.conflict('Your profile is already set up.');

  return getMyProfile(userId);
}

// Turns a validated clearable field ({ value } or { clear: true }) into $set/$unset entries.
function applyClearableField(update, field, change) {
  if (!change) return;
  if (change.clear) update.$unset[field] = 1;
  else update.$set[field] = change.value;
}

// Applies a partial profile edit (displayName, bio, interests, city, occupation).
export async function updateMyProfile(userId, changes) {
  await loadOnboardedAccount(userId);
  const update = { $set: {}, $unset: {} };

  if (changes.displayName) update.$set.displayName = changes.displayName;
  applyClearableField(update, 'bio', changes.bio);
  applyClearableField(update, 'city', changes.city);
  applyClearableField(update, 'occupation', changes.occupation);

  if (changes.interests) {
    const interestIds = await resolveInterestIds(changes.interests);
    if (!interestIds) throw ApiError.validation([{ field: 'interests', reason: 'UNKNOWN_INTEREST' }]);
    update.$set.interestIds = interestIds;
  }

  await Profile.updateOne({ userId }, update);
  return getMyProfile(userId);
}

// Replaces the discovery preferences (age range, distance, who to show).
export async function updatePreferences(userId, preferences) {
  await loadOnboardedAccount(userId);
  await Profile.updateOne({ userId }, { $set: { preferences } });
  return preferences;
}

// Replaces the member's interests with known interest ids.
export async function replaceInterests(userId, interestIds) {
  await loadOnboardedAccount(userId);
  if (!(await areKnownInterestIds(interestIds))) {
    throw ApiError.validation([{ field: 'interestIds', reason: 'UNKNOWN_INTEREST' }]);
  }
  await Profile.updateOne({ userId }, { $set: { interestIds } });
  return getMyProfile(userId);
}

// Loads another member the viewer is allowed to see. Anyone hidden (blocked either way, banned,
// suspended, pending deletion or not onboarded) is reported as 404 so nothing leaks.
export async function findVisibleMember(viewerId, targetUserId) {
  const [user, profile] = await Promise.all([User.findById(targetUserId), Profile.findOne({ userId: targetUserId })]);
  if (!user || !profile || !isVisibleMember(user)) throw ApiError.notFound();
  if (viewerId !== targetUserId && !isDiscoverableProfile(profile)) throw ApiError.notFound();
  if (viewerId !== targetUserId && (await isBlockedEitherWay(viewerId, targetUserId))) throw ApiError.notFound();
  return { user, profile };
}

// Returns another member's PublicProfile, with the distance from the viewer when both shared a location.
export async function getPublicProfile(viewerId, targetUserId) {
  const { user, profile } = await findVisibleMember(viewerId, targetUserId);
  const viewerProfile = await Profile.findOne({ userId: viewerId }).select('location').lean();
  return toSinglePublicProfile(profile, user, viewerProfile?.location ?? null);
}
