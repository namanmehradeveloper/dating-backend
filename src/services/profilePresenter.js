// Turns Profile and User documents into the API shapes:
//   MyProfile     - everything the owner may see (phone, gender, preferences, verification state)
//   PublicProfile - what other members see (never phone, date of birth, preferences, location or moderation data)

import { calculateAge } from '../utils/age.js';
import { buildFileUrl } from '../utils/fileUrls.js';
import { loadInterestLabels } from './interest.service.js';

const EARTH_RADIUS_KM = 6371;

// Converts degrees to radians for the distance formula.
function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// Returns the distance in whole kilometres between two GeoJSON points, or null when either is missing.
export function distanceInKm(pointA, pointB) {
  if (!pointA?.coordinates?.length || !pointB?.coordinates?.length) return null;
  const [lngA, latA] = pointA.coordinates;
  const [lngB, latB] = pointB.coordinates;

  const dLat = toRadians(latB - latA);
  const dLng = toRadians(lngB - lngA);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLng / 2) ** 2;
  const kilometres = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  return Math.max(1, Math.round(kilometres));
}

// Returns photos in display order with absolute URLs.
// Public feeds only show approved photos; the owner sees every status when includeModeration is set.
function presentPhotos(photos = [], { includeModeration = false, approvedOnly = false } = {}) {
  return [...photos]
    .filter((photo) => {
      if (!approvedOnly) return true;
      const status = photo.moderationStatus ?? 'APPROVED';
      return status === 'APPROVED';
    })
    .sort((a, b) => a.order - b.order)
    .map((photo) => {
      const presented = { id: photo._id, url: buildFileUrl(photo.relativePath), order: photo.order };
      if (includeModeration) presented.moderationStatus = photo.moderationStatus ?? 'APPROVED';
      return presented;
    });
}

// Returns basics as a plain object; documents hold a Map, lean queries a plain object.
function basicsToObject(basics) {
  if (!basics) return {};
  return basics instanceof Map ? Object.fromEntries(basics) : { ...basics };
}

// Returns the optional "about me" fields only when they are set, matching the documented shape.
function presentOptionalDetails(profile) {
  const details = {};
  const basics = basicsToObject(profile.basics);
  if (profile.relationshipGoal) details.relationshipGoal = profile.relationshipGoal;
  if (Object.keys(basics).length > 0) details.basics = basics;
  if (profile.prompt?.promptId) details.prompt = { promptId: profile.prompt.promptId, answer: profile.prompt.answer };
  return details;
}

// Builds a PublicProfile. `labels` maps interest ids to labels; `viewerLocation` is used only for distanceKm.
export function toPublicProfile(profile, user, { labels = new Map(), viewerLocation = null } = {}) {
  return {
    id: profile.userId,
    displayName: profile.displayName,
    age: calculateAge(profile.dateOfBirth),
    bio: profile.bio ?? null,
    interests: (profile.interestIds ?? []).map((id) => labels.get(id)).filter(Boolean),
    photos: presentPhotos(profile.photos, { approvedOnly: true }),
    city: profile.city ?? null,
    occupation: profile.occupation ?? null,
    distanceKm: distanceInKm(viewerLocation, profile.location),
    isVerified: user?.verificationStatus === 'VERIFIED',
    ...presentOptionalDetails(profile),
  };
}

// Builds PublicProfiles for a list of profiles, loading every interest label with one query.
export async function toPublicProfiles(profiles, usersById, viewerLocation = null) {
  const labels = await loadInterestLabels(profiles.flatMap((profile) => profile.interestIds ?? []));
  return profiles.map((profile) => toPublicProfile(profile, usersById.get(profile.userId), { labels, viewerLocation }));
}

// Builds one PublicProfile, loading its interest labels.
export async function toSinglePublicProfile(profile, user, viewerLocation = null) {
  const labels = await loadInterestLabels(profile.interestIds ?? []);
  return toPublicProfile(profile, user, { labels, viewerLocation });
}

// Builds MyProfile for the signed-in member. Works before onboarding, when there may be no profile yet.
export async function toMyProfile(user, profile) {
  const labels = await loadInterestLabels(profile?.interestIds ?? []);
  const preferences = profile?.preferences;

  return {
    id: user._id,
    displayName: profile?.displayName ?? null,
    age: profile?.dateOfBirth ? calculateAge(profile.dateOfBirth) : null,
    bio: profile?.bio ?? null,
    interests: (profile?.interestIds ?? []).map((id) => labels.get(id)).filter(Boolean),
    interestIds: profile?.interestIds ?? [],
    photos: presentPhotos(profile?.photos, { includeModeration: true }),
    city: profile?.city ?? null,
    occupation: profile?.occupation ?? null,
    distanceKm: null,
    isVerified: user.verificationStatus === 'VERIFIED',
    phoneNumber: user.phoneNumber ?? null,
    email: user.email ?? null,
    gender: user.onboardingComplete ? (profile?.gender ?? null) : null,
    showGender: profile?.showGender ?? false,
    preferences: preferences
      ? { minAge: preferences.minAge, maxAge: preferences.maxAge, maxDistanceKm: preferences.maxDistanceKm, showMe: preferences.showMe }
      : null,
    verificationStatus: user.verificationStatus,
    onboardingComplete: user.onboardingComplete,
    ...(profile ? presentOptionalDetails(profile) : {}),
  };
}
