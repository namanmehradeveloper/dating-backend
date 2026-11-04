// Validates admin panel query strings and request bodies.

import { EDITABLE_SETTINGS } from '../config/catalog.js';
import { CMS_STATUSES, CMS_TYPES } from '../models/CmsContent.js';
import { COUPON_TIERS, COUPON_TYPES } from '../models/Coupon.js';
import { EXPERIMENT_STATUSES } from '../models/Experiment.js';
import { CONVERSATION_STATUSES } from '../models/Conversation.js';
import { MATCH_STATUSES } from '../models/Match.js';
import { CAMPAIGN_AUDIENCES, CAMPAIGN_TYPES } from '../models/NotificationCampaign.js';
import { REPORT_REASONS, REPORT_STATUSES, REPORT_TARGET_TYPES } from '../models/Report.js';
import { RISK_STATUSES } from '../models/UserRiskSignal.js';
import { SWIPE_ACTIONS } from '../models/Swipe.js';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '../models/SupportTicket.js';
import {
  GENDERS,
  PHOTO_MODERATION_STATUSES,
  RELATIONSHIP_GOALS,
  SHOW_ME_OPTIONS,
  VISIBILITY_STATUSES,
} from '../models/Profile.js';
import { PERMISSION_ACTIONS, PERMISSION_MODULES, SYSTEM_STAFF_ROLES } from '../config/permissions.catalog.js';
import { ACCOUNT_STATUSES, ROLES, STAFF_ROLES, VERIFICATION_STATUSES } from '../models/User.js';
import { DASHBOARD_RANGES, MAX_CUSTOM_DAYS } from '../services/admin/adminDashboard.service.js';
import { ApiError } from '../utils/ApiError.js';
import {
  checkBoolean,
  checkEmail,
  checkEnum,
  checkInteger,
  checkIsoDate,
  checkPhoneNumber,
  checkText,
  checkTimestamp,
  checkUniqueStringList,
  isMissing,
  isPlainObject,
  requireObjectBody,
  throwIfInvalid,
  trimmedText,
} from './common.js';

// Reads an optional query-string filter that must be one of `options`.
function readEnumFilter(details, query, field, options) {
  const value = query[field];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !options.includes(value)) {
    details.push({ field, reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  return value;
}

// Reads an optional free-text query-string filter (search text, ids, action names).
function readTextFilter(details, query, field, max) {
  const value = query[field];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > max) {
    details.push({ field, reason: 'INVALID' });
    return undefined;
  }
  return value.trim() || undefined;
}

// Throws NO_FIELDS when a PATCH body changes nothing.
function requireSomeField(values) {
  if (Object.values(values).every((value) => value === undefined)) {
    throw ApiError.validation([{ field: 'body', reason: 'NO_FIELDS' }]);
  }
}

// GET /admin/users?q=&status=&role=&verificationStatus=&online=&activity=&visibility=&photoModeration=&onboardingComplete=&gender=&sortBy=&sortDir=
export function validateUserListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    status: readEnumFilter(details, query, 'status', ACCOUNT_STATUSES),
    role: readEnumFilter(details, query, 'role', ROLES),
    verificationStatus: readEnumFilter(details, query, 'verificationStatus', VERIFICATION_STATUSES),
    online: readEnumFilter(details, query, 'online', ['true', 'false']),
    activity: readEnumFilter(details, query, 'activity', ['active', 'inactive']),
    visibility: readEnumFilter(details, query, 'visibility', VISIBILITY_STATUSES),
    photoModeration: readEnumFilter(details, query, 'photoModeration', PHOTO_MODERATION_STATUSES),
    onboardingComplete: readEnumFilter(details, query, 'onboardingComplete', ['true', 'false']),
    gender: readEnumFilter(details, query, 'gender', GENDERS),
    sortBy: readEnumFilter(details, query, 'sortBy', ['createdAt', 'lastActiveAt']) ?? 'createdAt',
    sortDir: readEnumFilter(details, query, 'sortDir', ['asc', 'desc']) ?? 'desc',
  };
  throwIfInvalid(details);
  return filters;
}

// POST /admin/users — create a member by phone with profile fields.
export function validateUserCreate(body) {
  requireObjectBody(body);
  const details = [];

  let email;
  if (!isMissing(body.email)) {
    email = checkEmail(details, body.email);
  }

  const minAge = checkInteger(details, 'minAge', body.minAge ?? 18, { min: 18, max: 99 });
  const maxAge = checkInteger(details, 'maxAge', body.maxAge ?? 99, { min: 18, max: 99 });
  if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
    details.push({ field: 'minAge', reason: 'OUT_OF_RANGE' });
  }

  const input = {
    phoneNumber: checkPhoneNumber(details, body.phoneNumber),
    email,
    displayName: checkText(details, 'displayName', body.displayName, { max: 40, reason: 'LENGTH_1_40' }),
    dateOfBirth: checkIsoDate(details, 'dateOfBirth', body.dateOfBirth),
    gender: checkEnum(details, 'gender', body.gender, GENDERS),
    showGender: checkBoolean(details, 'showGender', body.showGender, { required: false }) ?? false,
    relationshipGoal: checkEnum(details, 'relationshipGoal', body.relationshipGoal, RELATIONSHIP_GOALS),
    bio: isMissing(body.bio) ? undefined : checkText(details, 'bio', body.bio, { min: 1, max: 500, reason: 'MAX_500', required: false }),
    city: isMissing(body.city) ? undefined : checkText(details, 'city', body.city, { max: 80, reason: 'INVALID_LENGTH', required: false }),
    occupation: isMissing(body.occupation)
      ? undefined
      : checkText(details, 'occupation', body.occupation, { max: 80, reason: 'INVALID_LENGTH', required: false }),
    status: checkEnum(details, 'status', body.status ?? 'ACTIVE', ACCOUNT_STATUSES),
    verificationStatus: checkEnum(details, 'verificationStatus', body.verificationStatus ?? 'NONE', VERIFICATION_STATUSES),
    visibilityStatus: checkEnum(details, 'visibilityStatus', body.visibilityStatus ?? 'VISIBLE', VISIBILITY_STATUSES),
    minAge,
    maxAge,
    maxDistanceKm: checkInteger(details, 'maxDistanceKm', body.maxDistanceKm ?? 80, { min: 1, max: 500, reason: 'RANGE_1_500' }),
    showMe: checkEnum(details, 'showMe', body.showMe ?? 'EVERYONE', SHOW_ME_OPTIONS),
  };

  throwIfInvalid(details);
  return input;
}

// POST /admin/users/:userId/deletion: { reason (3–500) }.
export function validateUserDeletion(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  throwIfInvalid(details);
  return { reason };
}

// GET /admin/users/:userId/reports?direction=against|by
export function validateUserReportsQuery(query) {
  const details = [];
  const direction = readEnumFilter(details, query, 'direction', ['against', 'by']) ?? 'against';
  throwIfInvalid(details);
  return { direction };
}

// PATCH /admin/users/:userId/status: { status, reason (3–500), until? (future, SUSPENDED only) }.
export function validateStatusChange(body) {
  requireObjectBody(body);
  const details = [];
  const change = {
    status: checkEnum(details, 'status', body.status, ACCOUNT_STATUSES),
    reason: checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' }),
    until: checkTimestamp(details, 'until', body.until),
  };
  if (change.until && change.status !== 'SUSPENDED') details.push({ field: 'until', reason: 'ONLY_FOR_SUSPENDED' });
  else if (change.until && change.until <= new Date()) details.push({ field: 'until', reason: 'MUST_BE_FUTURE' });
  throwIfInvalid(details);
  return change;
}

// GET /admin/reports?status=&targetType=&reason=
export function validateReportListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    status: readEnumFilter(details, query, 'status', REPORT_STATUSES),
    targetType: readEnumFilter(details, query, 'targetType', REPORT_TARGET_TYPES),
    reason: readEnumFilter(details, query, 'reason', REPORT_REASONS),
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/reports/:reportId: { status?: IN_REVIEW|ACTIONED|DISMISSED, resolutionNote?, assignToMe? }.
export function validateReportUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const update = {
    status: checkEnum(details, 'status', body.status, ['IN_REVIEW', 'ACTIONED', 'DISMISSED'], { required: false }),
    resolutionNote: checkText(details, 'resolutionNote', body.resolutionNote, { max: 1000, reason: 'MAX_1000', required: false }),
    assignToMe: checkBoolean(details, 'assignToMe', body.assignToMe, { required: false }),
  };
  throwIfInvalid(details);
  requireSomeField(update);
  return update;
}

// GET /admin/verifications?status=&sortBy=&sortDir=&q=
export function validateVerificationListQuery(query) {
  const details = [];
  const filters = {
    status: readEnumFilter(details, query, 'status', ['PENDING', 'APPROVED', 'REJECTED']),
    sortBy: readEnumFilter(details, query, 'sortBy', ['createdAt', 'reviewedAt']) ?? 'createdAt',
    sortDir: readEnumFilter(details, query, 'sortDir', ['asc', 'desc']) ?? 'desc',
    q: readTextFilter(details, query, 'q', 100),
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/verifications/:id: { status: APPROVED|REJECTED, reason (required when rejecting) }.
export function validateVerificationReview(body) {
  requireObjectBody(body);
  const details = [];
  const status = checkEnum(details, 'status', body.status, ['APPROVED', 'REJECTED']);
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500', required: status === 'REJECTED' });
  throwIfInvalid(details);
  return { status, reason };
}

// GET /admin/support/tickets?status=&category=
export function validateTicketListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    status: readEnumFilter(details, query, 'status', TICKET_STATUSES),
    category: readEnumFilter(details, query, 'category', TICKET_CATEGORIES),
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/support/tickets/:ticketId: { status }.
export function validateTicketUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const status = checkEnum(details, 'status', body.status, TICKET_STATUSES);
  throwIfInvalid(details);
  return { status };
}

// POST /admin/support/tickets/:ticketId/messages: { body (1–5000) }.
export function validateTicketReply(body) {
  requireObjectBody(body);
  const details = [];
  const text = checkText(details, 'body', body.body, { max: 5000, reason: 'LENGTH_1_5000' });
  throwIfInvalid(details);
  return { body: text };
}

// POST /admin/notifications: { title, body, type, audience, targetUserId (SINGLE_USER only) }.
export function validateCampaign(body) {
  requireObjectBody(body);
  const details = [];
  const campaign = {
    title: checkText(details, 'title', body.title, { max: 80, reason: 'LENGTH_1_80' }),
    body: checkText(details, 'body', body.body, { max: 500, reason: 'LENGTH_1_500' }),
    type: checkEnum(details, 'type', body.type, CAMPAIGN_TYPES),
    audience: checkEnum(details, 'audience', body.audience, CAMPAIGN_AUDIENCES),
  };
  if (campaign.audience === 'SINGLE_USER') {
    campaign.targetUserId = checkText(details, 'targetUserId', body.targetUserId, { max: 64, reason: 'INVALID' });
  } else if (body.targetUserId !== undefined) {
    details.push({ field: 'targetUserId', reason: 'ONLY_FOR_SINGLE_USER' });
  }
  throwIfInvalid(details);
  return campaign;
}

// GET /admin/notifications?q=
export function validateCampaignListQuery(query) {
  const details = [];
  const filters = { q: readTextFilter(details, query, 'q', 100) };
  throwIfInvalid(details);
  return filters;
}

// GET /admin/audit-logs?actorId=&targetId=&action=&targetType=
export function validateAuditQuery(query) {
  const details = [];
  const filters = {
    actorId: readTextFilter(details, query, 'actorId', 64),
    targetId: readTextFilter(details, query, 'targetId', 64),
    action: readTextFilter(details, query, 'action', 64),
    targetType: readTextFilter(details, query, 'targetType', 64),
  };
  throwIfInvalid(details);
  return filters;
}

// GET /admin/subscriptions?tier=&isActive=true|false
export function validateSubscriptionListQuery(query) {
  const details = [];
  const q = readTextFilter(details, query, 'q', 100);
  const tier = readEnumFilter(details, query, 'tier', ['FREE', 'PLUS']);
  const isActive = readEnumFilter(details, query, 'isActive', ['true', 'false']);
  throwIfInvalid(details);
  return { q, tier, isActive: isActive === undefined ? undefined : isActive === 'true' };
}

// PATCH /admin/settings: any editable setting, each a whole number within its allowed range.
export function validateSettingsUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    const rule = EDITABLE_SETTINGS[key];
    if (!rule) {
      details.push({ field: key, reason: 'UNKNOWN_FIELD' });
    } else if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      details.push({ field: key, reason: `RANGE_${rule.min}_${rule.max}` });
    } else {
      changes[key] = value;
    }
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// Shared ?days=7|30|90 for stats endpoints.
export function validateDaysQuery(query) {
  const details = [];
  const raw = query.days;
  let days = 7;
  if (raw !== undefined && raw !== '') {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !DASHBOARD_RANGES.includes(Number(raw))) {
      details.push({ field: 'days', reason: 'UNKNOWN_OPTION' });
    } else {
      days = Number(raw);
    }
  }
  throwIfInvalid(details);
  return { days };
}

// GET /admin/messaging/conversations?status=&q=
export function validateMessagingListQuery(query) {
  const details = [];
  const filters = {
    status: readEnumFilter(details, query, 'status', CONVERSATION_STATUSES),
    q: readTextFilter(details, query, 'q', 100),
  };
  throwIfInvalid(details);
  return filters;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /admin/dashboard?days=7|30|90 or ?from=YYYY-MM-DD&to=YYYY-MM-DD
export function validateDashboardQuery(query) {
  const details = [];
  const hasFrom = !isMissing(query.from);
  const hasTo = !isMissing(query.to);

  if (hasFrom || hasTo) {
    const from = checkIsoDate(details, 'from', query.from);
    const to = checkIsoDate(details, 'to', query.to);
    if (from && to) {
      if (from > to) details.push({ field: 'to', reason: 'MUST_BE_ON_OR_AFTER_FROM' });
      else {
        const span = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
        if (span > MAX_CUSTOM_DAYS) details.push({ field: 'to', reason: 'RANGE_MAX_366' });
      }
    }
    throwIfInvalid(details);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  }

  const raw = query.days;
  let days = 7;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (DASHBOARD_RANGES.includes(n)) days = n;
  }
  return { days };
}

const MATCH_BUCKETS = ['active', 'inactive', 'unmatched', 'expired'];
const MATCH_CONFIG_KEYS = ['matchExpiryDays', 'matchInactiveDays', 'matchAlgorithmVersion', 'matchFraudNewMatchesPerDay'];
const MATCH_ADMIN_END_REASONS = ['MODERATION', 'BLOCK', 'ACCOUNT_DELETED', 'EXPIRED'];

// GET /admin/matches?status=&q=&bucket=&algorithmVersion=
export function validateMatchListQuery(query) {
  const details = [];
  const filters = {
    status: readEnumFilter(details, query, 'status', MATCH_STATUSES),
    bucket: readEnumFilter(details, query, 'bucket', MATCH_BUCKETS),
    algorithmVersion: readTextFilter(details, query, 'algorithmVersion', 16),
    q: readTextFilter(details, query, 'q', 100),
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/matches/config
export function validateMatchConfigUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {};
  for (const key of MATCH_CONFIG_KEYS) {
    if (body[key] === undefined) continue;
    const rule = EDITABLE_SETTINGS[key];
    const value = checkInteger(details, key, body[key], { min: rule.min, max: rule.max });
    if (value !== undefined) changes[key] = value;
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// POST /admin/matches/:matchId/end
export function validateMatchEndBody(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkEnum(details, 'reason', body.reason ?? 'MODERATION', MATCH_ADMIN_END_REASONS);
  throwIfInvalid(details);
  return { reason };
}

// GET /admin/swipes?userId=&action=&direction=
export function validateSwipeListQuery(query) {
  const details = [];
  const filters = {
    userId: readTextFilter(details, query, 'userId', 64),
    action: readEnumFilter(details, query, 'action', SWIPE_ACTIONS),
    direction: readEnumFilter(details, query, 'direction', ['sent', 'received']) ?? 'sent',
  };
  if (!filters.userId) details.push({ field: 'userId', reason: 'REQUIRED' });
  throwIfInvalid(details);
  return filters;
}

const SWIPE_ENTITLEMENT_KEYS = ['freeDailyLikes', 'freeDailySuperLikes', 'freeDailyRewinds', 'swipeAbuseThresholdPerDay'];

// PATCH /admin/swipes/entitlements
export function validateSwipeEntitlementsUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {};
  for (const key of SWIPE_ENTITLEMENT_KEYS) {
    if (body[key] === undefined) continue;
    const rule = EDITABLE_SETTINGS[key];
    const value = checkInteger(details, key, body[key], { min: rule.min, max: rule.max });
    if (value !== undefined) changes[key] = value;
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// GET /admin/blocks?blockerId=&blockedId=&q=&mutual=
export function validateBlockListQuery(query) {
  const details = [];
  const filters = {
    blockerId: readTextFilter(details, query, 'blockerId', 64),
    blockedId: readTextFilter(details, query, 'blockedId', 64),
    q: readTextFilter(details, query, 'q', 100),
    mutual: readEnumFilter(details, query, 'mutual', ['true', 'false']),
  };
  throwIfInvalid(details);
  return filters;
}

// POST /admin/staff: { email, password, role: MODERATOR|ADMIN }.
function checkStaffRoleSlug(details, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  const role = value.trim().toUpperCase();
  const ok = SYSTEM_STAFF_ROLES.includes(role) || /^CUSTOM_[A-F0-9]{16}$/.test(role);
  if (!ok) {
    details.push({ field, reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  return role;
}

function optionalTwoFactorCode(details, body) {
  if (body.twoFactorCode === undefined || body.twoFactorCode === null || body.twoFactorCode === '') return undefined;
  if (typeof body.twoFactorCode !== 'string' || body.twoFactorCode.trim().length < 6) {
    details.push({ field: 'twoFactorCode', reason: 'INVALID_FORMAT' });
    return undefined;
  }
  return body.twoFactorCode.trim();
}

function checkPermissionMatrix(details, value) {
  if (!Array.isArray(value)) {
    details.push({ field: 'permissions', reason: 'INVALID' });
    return undefined;
  }
  const permissions = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry) || !PERMISSION_MODULES.includes(entry.module)) {
      details.push({ field: `permissions[${index}].module`, reason: 'UNKNOWN_OPTION' });
      continue;
    }
    if (!Array.isArray(entry.actions) || entry.actions.some((action) => !PERMISSION_ACTIONS.includes(action))) {
      details.push({ field: `permissions[${index}].actions`, reason: 'UNKNOWN_OPTION' });
      continue;
    }
    permissions.push({ module: entry.module, actions: [...new Set(entry.actions)] });
  }
  return permissions;
}

export function validateStaffListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    role: readTextFilter(details, query, 'role', 40),
    status: readEnumFilter(details, query, 'status', ACCOUNT_STATUSES),
    twoFactor: readEnumFilter(details, query, 'twoFactor', ['true', 'false']),
  };
  throwIfInvalid(details);
  return filters;
}

export function validateStaffCreate(body) {
  requireObjectBody(body);
  const details = [];
  const email = checkEmail(details, body.email);
  let password;
  if (body.password === undefined || body.password === null || body.password === '') {
    details.push({ field: 'password', reason: 'REQUIRED' });
  } else if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
    details.push({ field: 'password', reason: 'LENGTH_10_128' });
  } else {
    password = body.password;
  }
  const role = checkStaffRoleSlug(details, 'role', body.role);
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { email, password, role, twoFactorCode };
}

// PATCH /admin/staff/:userId/role: { role, twoFactorCode? }.
export function validateStaffRoleUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const role = checkStaffRoleSlug(details, 'role', body.role);
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { role, twoFactorCode };
}

export function validateStaffStatusUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const status = checkEnum(details, 'status', body.status, ['ACTIVE', 'SUSPENDED']);
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { status, reason, twoFactorCode };
}

export function validateStaffForceLogout(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { reason, twoFactorCode };
}

export function validateRoleCreate(body) {
  requireObjectBody(body);
  const details = [];
  const name = checkText(details, 'name', body.name, { max: 80, reason: 'LENGTH_1_80' });
  const description = checkText(details, 'description', body.description, { max: 500, reason: 'MAX_500', required: false }) ?? '';
  const rank = body.rank === undefined ? 20 : checkInteger(details, 'rank', body.rank, { min: 1, max: 30 });
  const permissions = body.permissions === undefined ? [] : checkPermissionMatrix(details, body.permissions);
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { name, description, rank, permissions, twoFactorCode };
}

export function validateRoleUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {
    name: checkText(details, 'name', body.name, { max: 80, reason: 'LENGTH_1_80', required: false }),
    description: checkText(details, 'description', body.description, { max: 500, reason: 'MAX_500', required: false }),
    rank: body.rank === undefined ? undefined : checkInteger(details, 'rank', body.rank, { min: 1, max: 30 }),
    isActive: checkBoolean(details, 'isActive', body.isActive, { required: false }),
    twoFactorCode: optionalTwoFactorCode(details, body),
  };
  throwIfInvalid(details);
  const { twoFactorCode, ...fields } = changes;
  requireSomeField(fields);
  return changes;
}

export function validateRolePermissionsUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const permissions = checkPermissionMatrix(details, body.permissions);
  const twoFactorCode = optionalTwoFactorCode(details, body);
  throwIfInvalid(details);
  return { permissions, twoFactorCode };
}

export function validateTwoFactorCodeBody(body) {
  requireObjectBody(body);
  const details = [];
  const code = checkText(details, 'code', body.code, { min: 6, max: 64, reason: 'INVALID_FORMAT' });
  throwIfInvalid(details);
  return { code };
}

const BASICS_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const OPTION_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

function checkClearableText(details, field, value, max, reason) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return { clear: true };
  if (typeof value !== 'string' || value.trim().length > max) {
    details.push({ field, reason });
    return undefined;
  }
  return { value: value.trim() };
}

function checkAdminBasics(details, value) {
  if (value === undefined) return undefined;
  if (value === null) return { clear: true };
  const entries = isPlainObject(value) ? Object.entries(value) : null;
  const isValid =
    entries &&
    entries.length <= 20 &&
    entries.every(([key, option]) => BASICS_KEY_PATTERN.test(key) && typeof option === 'string' && OPTION_ID_PATTERN.test(option));
  if (!isValid) {
    details.push({ field: 'basics', reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  return entries.length > 0 ? Object.fromEntries(entries) : { clear: true };
}

function checkAdminPrompt(details, value) {
  if (value === undefined) return undefined;
  if (value === null) return { clear: true };
  if (!isPlainObject(value)) {
    details.push({ field: 'prompt', reason: 'INVALID' });
    return undefined;
  }
  if (typeof value.promptId !== 'string' || !OPTION_ID_PATTERN.test(value.promptId)) {
    details.push({ field: 'prompt.promptId', reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  const answer = trimmedText(value.answer);
  if (!answer || answer.length > 150) {
    details.push({ field: 'prompt.answer', reason: 'INVALID' });
    return undefined;
  }
  return { promptId: value.promptId, answer };
}

// GET /admin/profiles?q=&gender=&relationshipGoal=&visibility=&boostActive=&photoModeration=&minCompleteness=&maxCompleteness=
export function validateProfileListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    gender: readEnumFilter(details, query, 'gender', GENDERS),
    relationshipGoal: readEnumFilter(details, query, 'relationshipGoal', RELATIONSHIP_GOALS),
    visibility: readEnumFilter(details, query, 'visibility', VISIBILITY_STATUSES),
    boostActive: readEnumFilter(details, query, 'boostActive', ['true', 'false']),
    photoModeration: readEnumFilter(details, query, 'photoModeration', ['PENDING', 'REJECTED', 'HAS_PENDING']),
    minCompleteness: query.minCompleteness === undefined || query.minCompleteness === ''
      ? undefined
      : checkInteger(details, 'minCompleteness', Number(query.minCompleteness), { min: 0, max: 5 }),
    maxCompleteness: query.maxCompleteness === undefined || query.maxCompleteness === ''
      ? undefined
      : checkInteger(details, 'maxCompleteness', Number(query.maxCompleteness), { min: 0, max: 5 }),
  };
  if (
    filters.minCompleteness !== undefined &&
    filters.maxCompleteness !== undefined &&
    filters.minCompleteness > filters.maxCompleteness
  ) {
    details.push({ field: 'minCompleteness', reason: 'OUT_OF_RANGE' });
  }
  throwIfInvalid(details);
  return filters;
}

// GET /admin/profiles/photo-queue?status=&q=
export function validatePhotoQueueQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    status: readEnumFilter(details, query, 'status', PHOTO_MODERATION_STATUSES) ?? 'PENDING',
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/profiles/:userId — audited corrections; reason required.
export function validateAdminProfileUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  const changes = {
    reason,
    displayName: body.displayName === undefined
      ? undefined
      : checkText(details, 'displayName', body.displayName, { max: 40, reason: 'LENGTH_1_40' }),
    bio: checkClearableText(details, 'bio', body.bio, 500, 'MAX_500'),
    city: checkClearableText(details, 'city', body.city, 80, 'INVALID_LENGTH'),
    occupation: checkClearableText(details, 'occupation', body.occupation, 80, 'INVALID_LENGTH'),
    relationshipGoal:
      body.relationshipGoal === undefined
        ? undefined
        : body.relationshipGoal === null || body.relationshipGoal === ''
          ? { clear: true }
          : checkEnum(details, 'relationshipGoal', body.relationshipGoal, RELATIONSHIP_GOALS),
    interestIds:
      body.interestIds === undefined
        ? undefined
        : checkUniqueStringList(details, 'interestIds', body.interestIds, { min: 0, max: 10, reason: 'COUNT_0_10' }),
    prompt: checkAdminPrompt(details, body.prompt),
    basics: checkAdminBasics(details, body.basics),
  };
  throwIfInvalid(details);
  const { reason: auditReason, ...fields } = changes;
  requireSomeField(fields);
  return changes;
}

// PATCH /admin/profiles/:userId/account — phone and/or password; reason required.
export function validateProfileAccountUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });

  let phoneNumber;
  if (body.phoneNumber !== undefined) {
    if (body.phoneNumber === null || (typeof body.phoneNumber === 'string' && body.phoneNumber.trim() === '')) {
      phoneNumber = { clear: true };
    } else {
      phoneNumber = checkPhoneNumber(details, body.phoneNumber);
    }
  }

  let password;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
      details.push({ field: 'password', reason: 'LENGTH_10_128' });
    } else {
      password = body.password;
    }
  }

  throwIfInvalid(details);
  if (phoneNumber === undefined && password === undefined) {
    throw ApiError.validation([{ field: 'body', reason: 'NO_FIELDS' }]);
  }
  return { reason, phoneNumber, password };
}

// PATCH /admin/profiles/:userId/visibility
export function validateProfileVisibilityUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const visibilityStatus = checkEnum(details, 'visibilityStatus', body.visibilityStatus, VISIBILITY_STATUSES);
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  let pausedUntil;
  let snoozedUntil;
  if (body.pausedUntil !== undefined && body.pausedUntil !== null && body.pausedUntil !== '') {
    pausedUntil = checkTimestamp(details, 'pausedUntil', body.pausedUntil);
  } else if (body.pausedUntil === null) {
    pausedUntil = null;
  }
  if (body.snoozedUntil !== undefined && body.snoozedUntil !== null && body.snoozedUntil !== '') {
    snoozedUntil = checkTimestamp(details, 'snoozedUntil', body.snoozedUntil);
  } else if (body.snoozedUntil === null) {
    snoozedUntil = null;
  }
  if (visibilityStatus === 'PAUSED' && pausedUntil === undefined) {
    // optional end time — open-ended pause is allowed
  }
  if (visibilityStatus === 'SNOOZED' && snoozedUntil === undefined) {
    // optional
  }
  const visibilityNote = checkClearableText(details, 'visibilityNote', body.visibilityNote, 500, 'MAX_500');
  throwIfInvalid(details);
  return { visibilityStatus, reason, pausedUntil, snoozedUntil, visibilityNote };
}

// PATCH /admin/profiles/:userId/boost
export function validateProfileBoostUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const active = checkBoolean(details, 'active', body.active);
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  let expiresAt;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    expiresAt = checkTimestamp(details, 'expiresAt', body.expiresAt);
  } else if (body.expiresAt === null) {
    expiresAt = null;
  }
  if (active && expiresAt === undefined) {
    details.push({ field: 'expiresAt', reason: 'REQUIRED' });
  }
  throwIfInvalid(details);
  return { active, reason, expiresAt };
}

// PATCH /admin/profiles/:userId/privacy
export function validateProfilePrivacyUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  const changes = {
    reason,
    showAge: checkBoolean(details, 'showAge', body.showAge, { required: false }),
    showDistance: checkBoolean(details, 'showDistance', body.showDistance, { required: false }),
    showOnlineStatus: checkBoolean(details, 'showOnlineStatus', body.showOnlineStatus, { required: false }),
    incognito: checkBoolean(details, 'incognito', body.incognito, { required: false }),
  };
  throwIfInvalid(details);
  const { reason: auditReason, ...fields } = changes;
  requireSomeField(fields);
  return changes;
}

// PATCH /admin/profiles/:userId/photos/:photoId/moderation
export function validatePhotoModeration(body) {
  requireObjectBody(body);
  const details = [];
  const status = checkEnum(details, 'status', body.status, ['APPROVED', 'REJECTED']);
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  throwIfInvalid(details);
  return { status, reason };
}

// DELETE /admin/profiles/:userId/photos/:photoId: { reason }.
export function validatePhotoRemoval(body) {
  requireObjectBody(body);
  const details = [];
  const reason = checkText(details, 'reason', body.reason, { min: 3, max: 500, reason: 'LENGTH_3_500' });
  throwIfInvalid(details);
  return { reason };
}

// GET /admin/cms?type=&status=&locale=
export function validateCmsListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    type: readEnumFilter(details, query, 'type', CMS_TYPES),
    status: readEnumFilter(details, query, 'status', CMS_STATUSES),
    locale: readTextFilter(details, query, 'locale', 16),
  };
  throwIfInvalid(details);
  return filters;
}

// POST /admin/cms
export function validateCmsCreate(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    title: checkText(details, 'title', body.title, { max: 200, reason: 'LENGTH_1_200' }),
    slug: checkText(details, 'slug', body.slug, { max: 120, reason: 'LENGTH_1_120' }),
    type: checkEnum(details, 'type', body.type, CMS_TYPES),
    body: checkText(details, 'body', body.body, { max: 50000, reason: 'MAX_50000', required: false }) ?? '',
    locale: checkText(details, 'locale', body.locale, { max: 16, reason: 'INVALID', required: false }) ?? 'en',
    status: checkEnum(details, 'status', body.status, CMS_STATUSES, { required: false }) ?? 'DRAFT',
  };
  throwIfInvalid(details);
  return input;
}

// PATCH /admin/cms/:id
export function validateCmsUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {
    title: checkText(details, 'title', body.title, { max: 200, reason: 'LENGTH_1_200', required: false }),
    slug: checkText(details, 'slug', body.slug, { max: 120, reason: 'LENGTH_1_120', required: false }),
    type: checkEnum(details, 'type', body.type, CMS_TYPES, { required: false }),
    body: checkText(details, 'body', body.body, { max: 50000, reason: 'MAX_50000', required: false }),
    locale: checkText(details, 'locale', body.locale, { max: 16, reason: 'INVALID', required: false }),
    status: checkEnum(details, 'status', body.status, CMS_STATUSES, { required: false }),
  };
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// GET /admin/coupons?isActive=
export function validateCouponListQuery(query) {
  const details = [];
  const q = readTextFilter(details, query, 'q', 100);
  const isActive = readEnumFilter(details, query, 'isActive', ['true', 'false']);
  throwIfInvalid(details);
  return { q, isActive: isActive === undefined ? undefined : isActive === 'true' };
}

// POST /admin/coupons
export function validateCouponCreate(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    code: checkText(details, 'code', body.code, { max: 40, reason: 'LENGTH_1_40' }),
    type: checkEnum(details, 'type', body.type, COUPON_TYPES),
    value: checkInteger(details, 'value', body.value, { min: 0, max: 100000, reason: 'OUT_OF_RANGE' }),
    maxRedemptions: checkInteger(details, 'maxRedemptions', body.maxRedemptions, { min: 1, max: 1000000, reason: 'OUT_OF_RANGE', required: false }),
    startsAt: checkTimestamp(details, 'startsAt', body.startsAt),
    endsAt: checkTimestamp(details, 'endsAt', body.endsAt),
    isActive: checkBoolean(details, 'isActive', body.isActive, { required: false }) ?? true,
  };
  if (body.eligibleTiers !== undefined) {
    if (!Array.isArray(body.eligibleTiers) || !body.eligibleTiers.every((tier) => COUPON_TIERS.includes(tier))) {
      details.push({ field: 'eligibleTiers', reason: 'UNKNOWN_OPTION' });
    } else {
      input.eligibleTiers = body.eligibleTiers;
    }
  }
  throwIfInvalid(details);
  return input;
}

// PATCH /admin/coupons/:id
export function validateCouponUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {
    type: checkEnum(details, 'type', body.type, COUPON_TYPES, { required: false }),
    value: checkInteger(details, 'value', body.value, { min: 0, max: 100000, reason: 'OUT_OF_RANGE', required: false }),
    maxRedemptions: checkInteger(details, 'maxRedemptions', body.maxRedemptions, { min: 1, max: 1000000, reason: 'OUT_OF_RANGE', required: false }),
    redemptionCount: checkInteger(details, 'redemptionCount', body.redemptionCount, { min: 0, max: 1000000, reason: 'OUT_OF_RANGE', required: false }),
    startsAt: checkTimestamp(details, 'startsAt', body.startsAt),
    endsAt: checkTimestamp(details, 'endsAt', body.endsAt),
    isActive: checkBoolean(details, 'isActive', body.isActive, { required: false }),
  };
  if (body.eligibleTiers !== undefined) {
    if (!Array.isArray(body.eligibleTiers) || !body.eligibleTiers.every((tier) => COUPON_TIERS.includes(tier))) {
      details.push({ field: 'eligibleTiers', reason: 'UNKNOWN_OPTION' });
    } else {
      changes.eligibleTiers = body.eligibleTiers;
    }
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// GET /admin/referrals?ownerUserId=&isActive=&q=
export function validateReferralListQuery(query) {
  const details = [];
  const isActive = readEnumFilter(details, query, 'isActive', ['true', 'false']);
  const filters = {
    ownerUserId: readTextFilter(details, query, 'ownerUserId', 64),
    isActive: isActive === undefined ? undefined : isActive === 'true',
    q: readTextFilter(details, query, 'q', 100),
  };
  throwIfInvalid(details);
  return filters;
}

// POST /admin/referrals
export function validateReferralCreate(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    code: checkText(details, 'code', body.code, { max: 40, reason: 'LENGTH_1_40' }),
    ownerUserId: checkText(details, 'ownerUserId', body.ownerUserId, { max: 64, reason: 'INVALID' }),
  };
  if (body.rewardConfig !== undefined) {
    if (!isPlainObject(body.rewardConfig)) details.push({ field: 'rewardConfig', reason: 'INVALID' });
    else input.rewardConfig = body.rewardConfig;
  }
  throwIfInvalid(details);
  return input;
}

// PATCH /admin/referrals/:id
export function validateReferralUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {
    isActive: checkBoolean(details, 'isActive', body.isActive, { required: false }),
  };
  if (body.rewardConfig !== undefined) {
    if (!isPlainObject(body.rewardConfig)) details.push({ field: 'rewardConfig', reason: 'INVALID' });
    else changes.rewardConfig = body.rewardConfig;
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}

// GET /admin/fraud/signals?status=&userId=
export function validateFraudSignalListQuery(query) {
  const details = [];
  const filters = {
    status: readEnumFilter(details, query, 'status', RISK_STATUSES),
    userId: readTextFilter(details, query, 'userId', 64),
  };
  throwIfInvalid(details);
  return filters;
}

// PATCH /admin/fraud/signals/:id
export function validateFraudSignalUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const status = checkEnum(details, 'status', body.status, ['REVIEWED', 'DISMISSED', 'OPEN']);
  throwIfInvalid(details);
  return { status };
}

// GET /admin/experiments?status=
export function validateExperimentListQuery(query) {
  const details = [];
  const filters = {
    q: readTextFilter(details, query, 'q', 100),
    status: readEnumFilter(details, query, 'status', EXPERIMENT_STATUSES),
  };
  throwIfInvalid(details);
  return filters;
}

// POST /admin/experiments
export function validateExperimentCreate(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    key: checkText(details, 'key', body.key, { max: 64, reason: 'LENGTH_1_64' }),
    name: checkText(details, 'name', body.name, { max: 120, reason: 'LENGTH_1_120' }),
    audiencePercent: checkInteger(details, 'audiencePercent', body.audiencePercent, { min: 1, max: 100, reason: 'OUT_OF_RANGE', required: false }) ?? 100,
    metrics: checkText(details, 'metrics', body.metrics, { max: 2000, reason: 'MAX_2000', required: false }) ?? '',
    status: checkEnum(details, 'status', body.status, EXPERIMENT_STATUSES, { required: false }) ?? 'DRAFT',
  };
  if (!Array.isArray(body.variants) || body.variants.length < 1) {
    details.push({ field: 'variants', reason: 'REQUIRED' });
  } else {
    const variants = [];
    for (const [index, variant] of body.variants.entries()) {
      if (!isPlainObject(variant)) {
        details.push({ field: `variants[${index}]`, reason: 'INVALID' });
        continue;
      }
      const key = checkText(details, `variants[${index}].key`, variant.key, { max: 40, reason: 'LENGTH_1_40' });
      const weight = checkInteger(details, `variants[${index}].weight`, variant.weight, { min: 0, max: 100, reason: 'OUT_OF_RANGE' });
      if (key && weight !== undefined) variants.push({ key, weight });
    }
    input.variants = variants;
  }
  throwIfInvalid(details);
  return input;
}

// PATCH /admin/experiments/:id
export function validateExperimentUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {
    name: checkText(details, 'name', body.name, { max: 120, reason: 'LENGTH_1_120', required: false }),
    audiencePercent: checkInteger(details, 'audiencePercent', body.audiencePercent, { min: 1, max: 100, reason: 'OUT_OF_RANGE', required: false }),
    metrics: checkText(details, 'metrics', body.metrics, { max: 2000, reason: 'MAX_2000', required: false }),
    status: checkEnum(details, 'status', body.status, EXPERIMENT_STATUSES, { required: false }),
  };
  if (body.variants !== undefined) {
    if (!Array.isArray(body.variants) || body.variants.length < 1) {
      details.push({ field: 'variants', reason: 'INVALID' });
    } else {
      const variants = [];
      for (const [index, variant] of body.variants.entries()) {
        if (!isPlainObject(variant)) {
          details.push({ field: `variants[${index}]`, reason: 'INVALID' });
          continue;
        }
        const key = checkText(details, `variants[${index}].key`, variant.key, { max: 40, reason: 'LENGTH_1_40' });
        const weight = checkInteger(details, `variants[${index}].weight`, variant.weight, { min: 0, max: 100, reason: 'OUT_OF_RANGE' });
        if (key && weight !== undefined) variants.push({ key, weight });
      }
      changes.variants = variants;
    }
  }
  throwIfInvalid(details);
  requireSomeField(changes);
  return changes;
}
