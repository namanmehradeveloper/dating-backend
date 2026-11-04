// Admin member management: search, details, a member's reports and matches, and status changes.
// Suspending or banning signs the member out everywhere and ends their matches.

import { env } from '../../config/env.js';
import { AuditLog } from '../../models/AuditLog.js';
import { Device } from '../../models/Device.js';
import { Match } from '../../models/Match.js';
import { Message } from '../../models/Message.js';
import { Profile } from '../../models/Profile.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { Report } from '../../models/Report.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { User } from '../../models/User.js';
import { UserRiskSignal } from '../../models/UserRiskSignal.js';
import { calculateAge, MINIMUM_AGE } from '../../utils/age.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, encodeCursor, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { DELETION_GRACE_DAYS, requestDeletion } from '../account.service.js';
import { recordAudit } from '../audit.service.js';
import { loadInterestLabels } from '../interest.service.js';
import { endAllMatchesForUser } from '../match.service.js';
import { notifyUser } from '../notification.service.js';
import { endUserSockets, getOnlineUserCount, getOnlineUserIds, isUserOnline } from '../realtime.service.js';
import { presentEntitlement } from '../subscription.service.js';
import { revokeAllUserTokens } from '../token.service.js';
import { loadUserCards, presentAdminUserSummary, presentProfileForReview } from './adminPresenter.js';
import { presentReportSummaries } from './adminReports.service.js';

const MAX_NAME_MATCHES = 500;
const INACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_NAME_THRESHOLD = 2;
const SORT_FIELDS = {
  createdAt: 'createdAt',
  lastActiveAt: 'lastActiveAt',
};

// Escapes text so it can be used inside a regular expression literally.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds the MongoDB filter for the search box: a user id, part of an email or phone number, or a profile name.
async function buildSearchFilter(q) {
  if (isValidId(q)) return { _id: q };
  const pattern = new RegExp(escapeRegex(q), 'i');
  const nameMatches = await Profile.find({ displayName: pattern }).select('userId').limit(MAX_NAME_MATCHES).lean();
  return {
    $or: [{ email: pattern }, { phoneNumber: pattern }, { _id: { $in: nameMatches.map((profile) => profile.userId) } }],
  };
}

function inactiveSince() {
  return new Date(Date.now() - INACTIVE_DAYS * DAY_MS);
}

// Extra list filters: online presence and active/inactive by lastActiveAt.
function buildActivityFilter(filters, onlineIds) {
  if (filters.online === 'true') {
    const ids = [...onlineIds];
    return { _id: { $in: ids.length ? ids : ['__none__'] } };
  }
  if (filters.online === 'false') {
    const ids = [...onlineIds];
    return ids.length ? { _id: { $nin: ids } } : {};
  }
  if (filters.activity === 'active') {
    return { lastActiveAt: { $gte: inactiveSince() } };
  }
  if (filters.activity === 'inactive') {
    return {
      $or: [{ lastActiveAt: { $lt: inactiveSince() } }, { lastActiveAt: null }, { lastActiveAt: { $exists: false } }],
    };
  }
  return {};
}

function resolveSort(filters) {
  const dateField = SORT_FIELDS[filters.sortBy] ?? 'createdAt';
  const direction = filters.sortDir === 'asc' ? 'asc' : 'desc';
  return { dateField, direction };
}

// Loads duplicate-name counts and open risk signals for the users on a page.
async function loadRiskIndicators(users, profiles) {
  const names = [...new Set(profiles.map((profile) => profile?.displayName).filter(Boolean))];
  const nameCounts = new Map();
  if (names.length) {
    const grouped = await Profile.aggregate([
      { $match: { displayName: { $in: names } } },
      { $group: { _id: '$displayName', count: { $sum: 1 } } },
    ]);
    for (const row of grouped) nameCounts.set(row._id, row.count);
  }

  const userIds = users.map((user) => user._id);
  const openSignals = await UserRiskSignal.find({ userId: { $in: userIds }, status: 'OPEN' })
    .select('userId totalScore signals')
    .lean();
  const signalByUser = new Map(openSignals.map((doc) => [doc.userId, doc]));

  return { nameCounts, signalByUser };
}

function riskFlagsFor(userId, profile, nameCounts, signalByUser) {
  const flags = [];
  const nameCount = profile?.displayName ? nameCounts.get(profile.displayName) ?? 0 : 0;
  if (nameCount >= DUPLICATE_NAME_THRESHOLD) {
    flags.push({ code: 'DUPLICATE_DISPLAY_NAME', label: `${nameCount} accounts share this name` });
  }
  const signal = signalByUser.get(userId);
  if (signal?.signals?.length) {
    for (const item of signal.signals) {
      if (!flags.some((flag) => flag.code === item.code)) {
        flags.push({ code: item.code, label: item.detail ?? item.code });
      }
    }
  }
  return {
    riskFlags: flags,
    riskScore: signal?.totalScore ?? 0,
    possibleDuplicate: nameCount >= DUPLICATE_NAME_THRESHOLD,
  };
}

// GET /admin/me — the signed-in staff member's own account (includes permissions for the UI).
export async function getStaffSession(userId) {
  const { flattenPermissions, getPermissionsForRole, getRankForRole, isAdminTier, isStaffRole } = await import('../rbac.service.js');
  const user = await User.findById(userId).select('email role status createdAt twoFactor.enabled').lean();
  if (!user || !(await isStaffRole(user.role))) throw ApiError.forbidden();
  const permissions = await getPermissionsForRole(user.role);
  return {
    id: user._id,
    email: user.email ?? null,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    twoFactorEnabled: Boolean(user.twoFactor?.enabled),
    isAdminTier: isAdminTier(user.role),
    rank: await getRankForRole(user.role),
    permissions,
    permissionKeys: flattenPermissions(permissions),
  };
}

// GET /admin/users/stats — KPI cards for the users page.
export async function getUserStats() {
  const members = { role: 'USER' };
  const since = inactiveSince();
  const onlineIds = getOnlineUserIds();
  const onlineMemberIds = [...onlineIds];

  const [total, active, inactive, suspended, banned, warned, online] = await Promise.all([
    User.countDocuments(members),
    User.countDocuments({ ...members, status: 'ACTIVE', lastActiveAt: { $gte: since } }),
    User.countDocuments({
      ...members,
      status: 'ACTIVE',
      $or: [{ lastActiveAt: { $lt: since } }, { lastActiveAt: null }, { lastActiveAt: { $exists: false } }],
    }),
    User.countDocuments({ ...members, status: 'SUSPENDED' }),
    User.countDocuments({ ...members, status: 'BANNED' }),
    User.countDocuments({ ...members, status: 'WARNED' }),
    onlineMemberIds.length
      ? User.countDocuments({ ...members, _id: { $in: onlineMemberIds } })
      : Promise.resolve(0),
  ]);

  return {
    total,
    active,
    inactive,
    online,
    onlineSockets: getOnlineUserCount(),
    suspended,
    banned,
    warned,
    inactiveDays: INACTIVE_DAYS,
  };
}

async function buildProfileConstraint(filters) {
  const query = {};
  if (filters.visibility) query.visibilityStatus = filters.visibility;
  if (filters.gender) query.gender = filters.gender;
  if (filters.photoModeration) {
    query.photos = { $elemMatch: { moderationStatus: filters.photoModeration } };
  }
  if (!Object.keys(query).length) return {};

  const rows = await Profile.find(query).select('userId').limit(5000).lean();
  const ids = rows.map((row) => row.userId);
  return { _id: { $in: ids.length ? ids : ['__none__'] } };
}

// GET /admin/users — newest accounts first (or sorted by lastActiveAt).
export async function listUsers(filters, { limit, cursor }, viewerRole) {
  const query = {};
  for (const field of ['status', 'role', 'verificationStatus']) {
    if (filters[field]) query[field] = filters[field];
  }
  if (filters.onboardingComplete === 'true') query.onboardingComplete = true;
  if (filters.onboardingComplete === 'false') query.onboardingComplete = false;
  const onlineIds = getOnlineUserIds();
  const searchFilter = filters.q ? await buildSearchFilter(filters.q) : {};
  const activityFilter = buildActivityFilter(filters, onlineIds);
  const profileFilter = await buildProfileConstraint(filters);
  const { dateField, direction } = resolveSort(filters);
  const cursorFilter = getAfterCursorFilter(cursor, dateField, direction);

  const docs = await User.find(mergeFilters(query, searchFilter, activityFilter, profileFilter, cursorFilter))
    .sort(getPageSort(dateField, direction))
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit, dateField);
  const profiles = await Profile.find({ userId: { $in: page.items.map((user) => user._id) } })
    .select('userId displayName photos visibilityStatus gender')
    .lean();
  const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
  const { nameCounts, signalByUser } = await loadRiskIndicators(page.items, profiles);

  return {
    items: page.items.map((user) => {
      const profile = profileByUserId.get(user._id);
      const risk = riskFlagsFor(user._id, profile, nameCounts, signalByUser);
      return {
        ...presentAdminUserSummary(user, profile, viewerRole),
        isOnline: isUserOnline(user._id),
        ...risk,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

// POST /admin/users — create a phone-based member with a completed profile.
export async function createUser(actor, input, viewerRole) {
  if (calculateAge(input.dateOfBirth) < MINIMUM_AGE) throw new ApiError('ACCOUNT_INELIGIBLE');

  if (await User.exists({ phoneNumber: input.phoneNumber })) {
    throw ApiError.conflict('An account with this phone number already exists.');
  }
  if (input.email && (await User.exists({ email: input.email }))) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  const user = await User.create({
    phoneNumber: input.phoneNumber,
    ...(input.email ? { email: input.email } : {}),
    role: 'USER',
    status: input.status,
    verificationStatus: input.verificationStatus,
    onboardingComplete: true,
  });

  const profile = await Profile.create({
    userId: user._id,
    displayName: input.displayName,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    showGender: input.showGender,
    relationshipGoal: input.relationshipGoal,
    bio: input.bio,
    city: input.city,
    occupation: input.occupation,
    photos: [],
    interestIds: [],
    visibilityStatus: input.visibilityStatus,
    preferences: {
      minAge: input.minAge,
      maxAge: input.maxAge,
      maxDistanceKm: input.maxDistanceKm,
      showMe: input.showMe,
    },
    acceptedTermsVersion: env.currentTermsVersion,
    acceptedTermsAt: new Date(),
  });

  await recordAudit(actor, {
    action: 'USER_CREATED',
    targetType: 'USER',
    targetId: user._id,
    metadata: {
      phoneNumber: input.phoneNumber,
      email: input.email ?? null,
      displayName: input.displayName,
      status: input.status,
      verificationStatus: input.verificationStatus,
    },
  });

  return {
    ...presentAdminUserSummary(user.toObject(), profile.toObject(), viewerRole),
    isOnline: false,
    riskFlags: [],
    riskScore: 0,
    possibleDuplicate: false,
  };
}

// Loads an account or throws 404.
async function loadUser(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound();
  return user;
}

// GET /admin/users/:userId — account, profile, entitlement and moderation counts.
export async function getUserDetail(userId, viewerRole) {
  const user = await loadUser(userId);
  const [profile, entitlement, reportsAgainst, openReportsAgainst, reportsMade, activeMatches, openRisk] = await Promise.all([
    Profile.findOne({ userId }).lean(),
    SubscriptionEntitlement.findOne({ userId }).lean(),
    Report.countDocuments({ targetUserId: userId }),
    Report.countDocuments({ targetUserId: userId, status: { $in: ['OPEN', 'IN_REVIEW'] } }),
    Report.countDocuments({ reporterId: userId }),
    Match.countDocuments({ userIds: userId, status: 'ACTIVE' }),
    UserRiskSignal.findOne({ userId, status: 'OPEN' }).lean(),
  ]);
  const interestLabels = await loadInterestLabels(profile?.interestIds ?? []);
  const duplicateNameCount = profile?.displayName
    ? await Profile.countDocuments({ displayName: profile.displayName })
    : 0;
  const riskFlags = [];
  if (duplicateNameCount >= DUPLICATE_NAME_THRESHOLD) {
    riskFlags.push({ code: 'DUPLICATE_DISPLAY_NAME', label: `${duplicateNameCount} accounts share this name` });
  }
  for (const item of openRisk?.signals ?? []) {
    if (!riskFlags.some((flag) => flag.code === item.code)) {
      riskFlags.push({ code: item.code, label: item.detail ?? item.code });
    }
  }

  return {
    ...presentAdminUserSummary(user, profile, viewerRole),
    isOnline: isUserOnline(userId),
    statusReason: user.statusReason ?? null,
    suspendedUntil: user.suspendedUntil ?? null,
    deletion: {
      status: user.deletion?.status ?? 'NONE',
      requestedAt: user.deletion?.requestedAt ?? null,
      scheduledFor: user.deletion?.scheduledFor ?? null,
      reason: user.deletion?.reason ?? null,
    },
    profile: presentProfileForReview(profile, interestLabels),
    entitlement: presentEntitlement(entitlement),
    stats: { reportsAgainst, openReportsAgainst, reportsMade, activeMatches },
    riskFlags,
    riskScore: openRisk?.totalScore ?? 0,
    possibleDuplicate: duplicateNameCount >= DUPLICATE_NAME_THRESHOLD,
    duplicateNameCount,
  };
}

// GET /admin/users/:userId/reports — reports against the member (default) or made by them.
export async function listUserReports(userId, { direction }, { limit, cursor }) {
  await loadUser(userId);
  const owner = direction === 'by' ? { reporterId: userId } : { targetUserId: userId };
  const docs = await Report.find({ ...owner, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: await presentReportSummaries(page.items), nextCursor: page.nextCursor };
}

// GET /admin/users/:userId/matches — the member's matches with message counts (never message text).
export async function listUserMatches(userId, { limit, cursor }) {
  await loadUser(userId);
  const docs = await Match.find({ userIds: userId, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);

  const conversationIds = page.items.map((match) => match.conversationId).filter(Boolean);
  const counts = await Message.aggregate([
    { $match: { conversationId: { $in: conversationIds } } },
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  const countByConversation = new Map(counts.map((entry) => [entry._id, entry.count]));
  const cardFor = await loadUserCards(page.items.map((match) => match.userIds.find((id) => id !== userId)));

  const items = page.items.map((match) => ({
    id: match._id,
    status: match.status,
    otherUser: cardFor(match.userIds.find((id) => id !== userId)),
    matchedAt: match.matchedAt ?? match.createdAt,
    endedAt: match.endedAt ?? null,
    endedReason: match.endedReason ?? null,
    conversationId: match.conversationId ?? null,
    messageCount: countByConversation.get(match.conversationId) ?? 0,
  }));
  return { items, nextCursor: page.nextCursor };
}

// GET /admin/users/:userId/sessions — registration + refresh-token login history (no token secrets).
export async function listUserSessions(userId, { limit, cursor }) {
  await loadUser(userId);
  const docs = await RefreshToken.find({ userId, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .select('familyId createdAt usedAt revokedAt revokedReason expiresAt')
    .lean();
  const page = buildPage(docs, limit);
  const devices = await Device.find({ userId }).select('platform appVersion lastSeenAt createdAt').lean();

  return {
    items: page.items.map((token) => ({
      id: token._id,
      familyId: token.familyId,
      signedInAt: token.createdAt,
      lastUsedAt: token.usedAt ?? null,
      revokedAt: token.revokedAt ?? null,
      revokedReason: token.revokedReason ?? null,
      expiresAt: token.expiresAt,
      status: token.revokedAt ? 'REVOKED' : token.expiresAt < new Date() ? 'EXPIRED' : 'ACTIVE',
    })),
    devices: devices.map((device) => ({
      id: device._id,
      platform: device.platform,
      appVersion: device.appVersion ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      registeredAt: device.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/users/:userId/activity — merged timeline of registration, logins and staff actions.
export async function listUserActivity(userId, { limit, cursor }) {
  const user = await loadUser(userId);
  const pageLimit = limit;

  const [audits, tokens] = await Promise.all([
    AuditLog.find({ targetType: 'USER', targetId: userId }).sort({ createdAt: -1 }).limit(100).lean(),
    RefreshToken.find({ userId }).sort({ createdAt: -1 }).limit(50).select('familyId createdAt revokedAt revokedReason').lean(),
  ]);

  const actorIds = [...new Set(audits.map((log) => log.actorId))];
  const cardFor = await loadUserCards(actorIds);

  const events = [
    {
      id: `reg_${user._id}`,
      type: 'REGISTRATION',
      title: 'Account registered',
      at: user.createdAt,
      metadata: { role: user.role },
      actor: null,
    },
    ...audits.map((log) => ({
      id: log._id,
      type: 'AUDIT',
      title: log.action,
      at: log.createdAt,
      metadata: log.metadata ?? {},
      actor: cardFor(log.actorId),
      actorRole: log.actorRole,
    })),
    ...tokens.map((token) => ({
      id: `tok_${token._id}`,
      type: 'LOGIN',
      title: token.revokedAt ? 'Session ended' : 'Signed in',
      at: token.revokedAt ?? token.createdAt,
      metadata: {
        familyId: token.familyId,
        revokedReason: token.revokedReason ?? null,
        signedInAt: token.createdAt,
      },
      actor: null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  // Cursor pagination over the in-memory merged timeline (bounded source queries above).
  let start = 0;
  if (cursor) {
    const index = events.findIndex(
      (event) => new Date(event.at).getTime() === cursor.date.getTime() && String(event.id) === cursor.id,
    );
    start = index >= 0 ? index + 1 : 0;
  }
  const slice = events.slice(start, start + pageLimit + 1);
  const hasMore = slice.length > pageLimit;
  const items = hasMore ? slice.slice(0, pageLimit) : slice;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(new Date(last.at), last.id) : null,
  };
}

// GET /admin/users/:userId/export — portable JSON of the member's account data (ADMIN).
export async function exportUserData(actor, userId) {
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('Only admins can export member data.');
  const detail = await getUserDetail(userId, actor.role);
  const [sessions, reportsAgainst, reportsBy] = await Promise.all([
    listUserSessions(userId, { limit: 50, cursor: null }),
    listUserReports(userId, { direction: 'against' }, { limit: 50, cursor: null }),
    listUserReports(userId, { direction: 'by' }, { limit: 50, cursor: null }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: actor.id,
    account: {
      id: detail.id,
      email: detail.email,
      phoneNumber: detail.phoneNumber,
      role: detail.role,
      status: detail.status,
      statusReason: detail.statusReason,
      verificationStatus: detail.verificationStatus,
      onboardingComplete: detail.onboardingComplete,
      createdAt: detail.createdAt,
      lastActiveAt: detail.lastActiveAt,
      deletion: detail.deletion,
    },
    profile: detail.profile,
    entitlement: detail.entitlement,
    stats: detail.stats,
    riskFlags: detail.riskFlags,
    sessions: sessions.items,
    devices: sessions.devices,
    reportsAgainst: reportsAgainst.items,
    reportsBy: reportsBy.items,
  };

  await recordAudit(actor, {
    action: 'USER_DATA_EXPORTED',
    targetType: 'USER',
    targetId: userId,
    metadata: { fields: Object.keys(payload) },
  });

  return payload;
}

// POST /admin/users/:userId/deletion — schedule the 14-day deletion grace period (ADMIN tier).
export async function scheduleUserDeletion(actor, userId, { reason }) {
  if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only admins can schedule account deletion.');
  }
  if (actor.id === userId) throw ApiError.forbidden('You cannot delete your own account from here.');
  const target = await loadUser(userId);
  if (target.role !== 'USER') throw ApiError.forbidden('Staff accounts cannot be deleted from the users module.');
  if (target.deletion?.status === 'SCHEDULED') {
    return {
      status: 'SCHEDULED',
      scheduledFor: target.deletion.scheduledFor,
      graceDays: DELETION_GRACE_DAYS,
    };
  }

  const result = await requestDeletion(userId, { reason, feedback: 'Scheduled by admin' });
  await recordAudit(actor, {
    action: 'USER_DELETION_SCHEDULED',
    targetType: 'USER',
    targetId: userId,
    metadata: { reason, scheduledFor: result.scheduledFor, graceDays: DELETION_GRACE_DAYS },
  });
  return { ...result, graceDays: DELETION_GRACE_DAYS };
}

// Enforces who may change whose status: nobody changes their own, only admins touch staff
// accounts, and only admins ban or lift a ban.
function assertMayChangeStatus(actor, target, newStatus) {
  if (actor.id === target._id) throw ApiError.forbidden('You cannot change your own account status.');
  if (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') return;
  if (target.role !== 'USER') throw ApiError.forbidden('Only admins can change staff accounts.');
  if (newStatus === 'BANNED' || target.status === 'BANNED') throw ApiError.forbidden('Only admins can ban or unban members.');
}

// Applies what a status change means outside the user record.
async function applyStatusSideEffects(actor, userId, status) {
  if (status === 'SUSPENDED' || status === 'BANNED') {
    await revokeAllUserTokens(userId, 'ACCOUNT_STATUS');
    endUserSockets(userId);
    await endAllMatchesForUser(userId, 'MODERATION', actor.id);
  }
  if (status === 'WARNED') {
    await notifyUser(userId, {
      type: 'SYSTEM',
      title: 'Account warning',
      body: 'Your account received a warning for breaking our community guidelines.',
    });
  }
}

// PATCH /admin/users/:userId/status
export async function changeUserStatus(actor, userId, { status, reason, until }) {
  const target = await loadUser(userId);
  assertMayChangeStatus(actor, target, status);

  await User.updateOne({ _id: userId }, { $set: { status, statusReason: reason, suspendedUntil: until ?? null } });
  await applyStatusSideEffects(actor, userId, status);
  await recordAudit(actor, {
    action: 'USER_STATUS_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: { from: target.status, to: status, reason, until: until ?? null },
  });
  return getUserDetail(userId, actor.role);
}
