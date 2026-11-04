// Shapes members and staff for the admin panel. Moderators see masked phone numbers and emails;
// only admins see full contact details. Secrets (password hashes, tokens) are never loaded.

import { Profile } from '../../models/Profile.js';
import { SYSTEM_STAFF_ROLES } from '../../config/permissions.catalog.js';
import { User } from '../../models/User.js';
import { isCustomRoleSlug } from '../rbac.service.js';
import { calculateAge } from '../../utils/age.js';
import { buildFileUrl } from '../../utils/fileUrls.js';
import { isValidId } from '../../validators/common.js';

const MEMBER_SEARCH_CAP = 500;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolves admin search text to member ids (usr_…, display name, or email). Empty means no match.
export async function resolveMemberIdsByQuery(q) {
  if (!q) return [];
  if (isValidId(q)) return q.startsWith('usr_') ? [q] : [];
  const pattern = new RegExp(escapeRegex(q), 'i');
  const [names, emails] = await Promise.all([
    Profile.find({ displayName: pattern }).select('userId').limit(MEMBER_SEARCH_CAP).lean(),
    User.find({ email: pattern }).select('_id').limit(MEMBER_SEARCH_CAP).lean(),
  ]);
  return [...new Set([...names.map((row) => row.userId), ...emails.map((row) => row._id)])];
}

// "+919876543210" -> "+91******3210".
export function maskPhone(phoneNumber) {
  if (!phoneNumber) return null;
  return `${phoneNumber.slice(0, 3)}${'*'.repeat(Math.max(phoneNumber.length - 7, 0))}${phoneNumber.slice(-4)}`;
}

// "alex@example.com" -> "a***@example.com".
export function maskEmail(email) {
  if (!email) return null;
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}

// Returns the phone and email a staff member may see for an account.
export function presentContact(user, viewerRole) {
  const showFull = viewerRole === 'ADMIN' || viewerRole === 'SUPER_ADMIN';
  return {
    email: showFull ? (user.email ?? null) : maskEmail(user.email),
    phoneNumber: showFull ? (user.phoneNumber ?? null) : maskPhone(user.phoneNumber),
  };
}

// Returns the URL of the first profile photo, or null.
export function firstPhotoUrl(profile) {
  const first = [...(profile?.photos ?? [])].sort((a, b) => a.order - b.order)[0];
  return first ? buildFileUrl(first.relativePath) : null;
}

// Name shown in admin lists: the profile name, or the email for staff, who have no profile.
function displayNameFor(user, profile) {
  if (profile?.displayName) return profile.displayName;
  if (SYSTEM_STAFF_ROLES.includes(user.role) || isCustomRoleSlug(user.role)) return user.email;
  return 'Unnamed member';
}

// A small user reference used inside admin lists (reports, tickets, audit logs...).
export function toUserCard(user, profile) {
  return {
    id: user._id,
    displayName: displayNameFor(user, profile),
    photoUrl: firstPhotoUrl(profile),
    role: user.role,
    status: user.status,
  };
}

// The card shown for an account that no longer exists (erased after deletion).
function deletedUserCard(userId) {
  return { id: userId, displayName: 'Deleted account', photoUrl: null, role: null, status: 'DELETED' };
}

// Loads cards for many user ids with two queries. Returns a lookup function id -> card (or null for no id).
export async function loadUserCards(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('email role status').lean(),
    Profile.find({ userId: { $in: ids } }).select('userId displayName photos').lean(),
  ]);
  const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
  const cards = new Map(users.map((user) => [user._id, toUserCard(user, profileByUserId.get(user._id))]));
  return (userId) => (userId ? (cards.get(userId) ?? deletedUserCard(userId)) : null);
}

function photoStats(profile) {
  const photos = profile?.photos ?? [];
  return {
    visibilityStatus: profile?.visibilityStatus ?? null,
    photoCount: photos.length,
    pendingPhotoCount: photos.filter((photo) => photo.moderationStatus === 'PENDING').length,
  };
}

// The row shown in the admin users list.
export function presentAdminUserSummary(user, profile, viewerRole) {
  return {
    ...toUserCard(user, profile),
    ...presentContact(user, viewerRole),
    ...photoStats(profile),
    gender: profile?.gender ?? null,
    verificationStatus: user.verificationStatus,
    onboardingComplete: user.onboardingComplete,
    deletionScheduled: user.deletion?.status === 'SCHEDULED',
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt ?? null,
  };
}

function basicsToObject(basics) {
  if (!basics) return {};
  return basics instanceof Map ? Object.fromEntries(basics) : { ...basics };
}

// The dating profile as moderators review it (includes gender and age, never exact location).
export function presentProfileForReview(profile, interestLabels) {
  if (!profile) return null;
  const age = calculateAge(profile.dateOfBirth);
  return {
    displayName: profile.displayName,
    age,
    ageEligible: age >= 18,
    gender: profile.gender,
    bio: profile.bio ?? null,
    city: profile.city ?? null,
    occupation: profile.occupation ?? null,
    relationshipGoal: profile.relationshipGoal ?? null,
    prompt: profile.prompt?.promptId ? { promptId: profile.prompt.promptId, answer: profile.prompt.answer } : null,
    basics: basicsToObject(profile.basics),
    interests: (profile.interestIds ?? []).map((id) => interestLabels.get(id)).filter(Boolean),
    preferences: {
      minAge: profile.preferences?.minAge ?? 18,
      maxAge: profile.preferences?.maxAge ?? 99,
      maxDistanceKm: profile.preferences?.maxDistanceKm ?? 80,
      showMe: profile.preferences?.showMe ?? 'EVERYONE',
    },
    photos: [...(profile.photos ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((photo) => ({
        id: photo._id,
        url: buildFileUrl(photo.relativePath),
        order: photo.order,
        moderationStatus: photo.moderationStatus ?? 'APPROVED',
        moderationReason: photo.moderationReason ?? null,
      })),
    visibilityStatus: profile.visibilityStatus || 'VISIBLE',
    pausedUntil: profile.pausedUntil ?? null,
    snoozedUntil: profile.snoozedUntil ?? null,
    boost: {
      active: Boolean(profile.boost?.active),
      expiresAt: profile.boost?.expiresAt ?? null,
      activatedAt: profile.boost?.activatedAt ?? null,
    },
    privacy: {
      showAge: profile.privacy?.showAge !== false,
      showDistance: profile.privacy?.showDistance !== false,
      showOnlineStatus: profile.privacy?.showOnlineStatus !== false,
      incognito: Boolean(profile.privacy?.incognito),
    },
    createdAt: profile.createdAt,
  };
}
