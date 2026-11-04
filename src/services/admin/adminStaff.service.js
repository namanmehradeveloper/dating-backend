// Staff account management: list, create, role/status changes, sessions, force logout, 2FA setup.

import bcrypt from 'bcryptjs';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { BCRYPT_ROUNDS } from '../auth.service.js';
import { recordAudit } from '../audit.service.js';
import {
  assertCanManageTargetRole,
  countAdminTier,
  ensureSystemRoles,
  getPermissionsForRole,
  getRankForRole,
  isAdminTier,
  staffRoleFilter,
} from '../rbac.service.js';
import { endUserSockets } from '../realtime.service.js';
import { revokeAllUserTokens } from '../token.service.js';
import {
  buildOtpAuthUrl,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  verifyTotp,
} from '../totp.service.js';
import { assertAssignableStaffRole } from './adminRoles.service.js';
import { loadUserCards, presentContact } from './adminPresenter.js';
import { assertStaffTwoFactor } from './staffSecurity.service.js';

export { assertStaffTwoFactor };

function presentStaff(user, card, viewerRole = 'ADMIN') {
  return {
    ...card,
    ...presentContact(user, isAdminTier(viewerRole) ? 'ADMIN' : viewerRole),
    twoFactorEnabled: Boolean(user.twoFactor?.enabled),
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt ?? null,
    updatedAt: user.updatedAt,
  };
}

// GET /admin/staff/stats
export async function getStaffStats() {
  await ensureSystemRoles();
  const filter = staffRoleFilter();
  const [total, active, suspended, with2fa, byRole] = await Promise.all([
    User.countDocuments(filter),
    User.countDocuments({ ...filter, status: 'ACTIVE' }),
    User.countDocuments({ ...filter, status: { $in: ['SUSPENDED', 'BANNED'] } }),
    User.countDocuments({ ...filter, 'twoFactor.enabled': true }),
    User.aggregate([{ $match: filter }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
  ]);
  return {
    total,
    active,
    suspended,
    with2fa,
    byRole: Object.fromEntries(byRole.map((row) => [row._id, row.count])),
  };
}

// GET /admin/staff — staff accounts newest first.
export async function listStaff(filters, { limit, cursor }) {
  await ensureSystemRoles();
  const query = { ...staffRoleFilter() };
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.email = pattern;
  }
  if (filters.role) query.role = filters.role;
  if (filters.status) query.status = filters.status;
  if (filters.twoFactor === 'true') query['twoFactor.enabled'] = true;
  if (filters.twoFactor === 'false') {
    query.$and = [...(query.$and ?? []), { $or: [{ 'twoFactor.enabled': false }, { twoFactor: { $exists: false } }] }];
  }

  const docs = await User.find({ ...query, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((user) => user._id));

  return {
    items: page.items.map((user) => presentStaff(user, cardFor(user._id), 'ADMIN')),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/staff/:userId
export async function getStaff(actor, userId) {
  await ensureSystemRoles();
  const user = await User.findById(userId).lean();
  if (!user || user.role === 'USER') throw ApiError.notFound();
  await assertCanManageTargetRole(actor.role, user.role);

  const [cardFor, permissions, rank] = await Promise.all([
    loadUserCards([userId]),
    getPermissionsForRole(user.role),
    getRankForRole(user.role),
  ]);

  return {
    ...presentStaff(user, cardFor(userId), actor.role),
    permissions,
    rank,
    statusReason: user.statusReason ?? null,
    suspendedUntil: user.suspendedUntil ?? null,
  };
}

// POST /admin/staff — create staff with email/password and an assignable role.
export async function createStaff(actor, { email, password, role, twoFactorCode }) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  await assertAssignableStaffRole(actor.role, role);

  if (await User.exists({ email })) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ email, passwordHash, role, onboardingComplete: true });

  await recordAudit(actor, {
    action: 'STAFF_CREATED',
    targetType: 'USER',
    targetId: user._id,
    metadata: { email, role },
  });

  const cardFor = await loadUserCards([user._id]);
  return presentStaff(user.toObject(), cardFor(user._id), actor.role);
}

// PATCH /admin/staff/:userId/role
export async function updateStaffRole(actor, userId, { role, twoFactorCode }) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  if (actor.id === userId) throw ApiError.forbidden('You cannot change your own role.');

  const target = await User.findById(userId).lean();
  if (!target || target.role === 'USER') throw ApiError.notFound();

  await assertCanManageTargetRole(actor.role, target.role);
  await assertAssignableStaffRole(actor.role, role);

  if (isAdminTier(target.role) && !isAdminTier(role)) {
    const adminCount = await countAdminTier();
    if (adminCount <= 1) throw ApiError.conflict('Cannot demote the last admin.');
  }

  await User.updateOne({ _id: userId }, { $set: { role } });
  await revokeAllUserTokens(userId, 'ROLE_CHANGED');
  await User.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
  endUserSockets(userId);

  await recordAudit(actor, {
    action: 'STAFF_ROLE_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: { from: target.role, to: role },
  });

  return getStaff(actor, userId);
}

// PATCH /admin/staff/:userId/status — activate / suspend staff (not self).
export async function updateStaffStatus(actor, userId, { status, reason, twoFactorCode }) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  if (actor.id === userId) throw ApiError.forbidden('You cannot change your own status.');
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
    throw ApiError.validation([{ field: 'status', reason: 'UNKNOWN_OPTION' }]);
  }

  const target = await User.findById(userId).lean();
  if (!target || target.role === 'USER') throw ApiError.notFound();
  await assertCanManageTargetRole(actor.role, target.role);

  if (isAdminTier(target.role) && status !== 'ACTIVE') {
    const adminCount = await countAdminTier();
    if (adminCount <= 1) throw ApiError.conflict('Cannot suspend the last admin.');
  }

  if (status === 'ACTIVE') {
    await User.updateOne(
      { _id: userId },
      { $set: { status: 'ACTIVE' }, $unset: { suspendedUntil: 1, statusReason: 1 } },
    );
  } else {
    await User.updateOne({ _id: userId }, { $set: { status, statusReason: reason } });
  }

  if (status !== 'ACTIVE') {
    await revokeAllUserTokens(userId, 'ACCOUNT_STATUS');
    await User.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
    endUserSockets(userId);
  }

  await recordAudit(actor, {
    action: 'STAFF_STATUS_CHANGED',
    targetType: 'USER',
    targetId: userId,
    metadata: { from: target.status, to: status, reason },
  });

  return getStaff(actor, userId);
}

// GET /admin/staff/:userId/sessions
export async function listStaffSessions(actor, userId) {
  const target = await User.findById(userId).lean();
  if (!target || target.role === 'USER') throw ApiError.notFound();
  await assertCanManageTargetRole(actor.role, target.role);

  const tokens = await RefreshToken.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
  return {
    items: tokens.map((token) => ({
      id: token._id,
      familyId: token.familyId,
      signedInAt: token.createdAt,
      lastUsedAt: token.updatedAt,
      expiresAt: token.expiresAt,
      status: token.revokedAt ? 'REVOKED' : token.usedAt ? 'ROTATED' : 'ACTIVE',
      revokedAt: token.revokedAt ?? null,
      revokedReason: token.revokedReason ?? null,
    })),
    sessionVersion: target.sessionVersion ?? 0,
  };
}

// POST /admin/staff/:userId/force-logout
export async function forceStaffLogout(actor, userId, { reason, twoFactorCode }) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  if (actor.id === userId) throw ApiError.forbidden('Use Sign out everywhere from your own session.');

  const target = await User.findById(userId).lean();
  if (!target || target.role === 'USER') throw ApiError.notFound();
  await assertCanManageTargetRole(actor.role, target.role);

  await User.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
  await revokeAllUserTokens(userId, 'FORCE_LOGOUT');
  endUserSockets(userId);

  await recordAudit(actor, {
    action: 'STAFF_FORCE_LOGOUT',
    targetType: 'USER',
    targetId: userId,
    metadata: { reason },
  });

  return { forced: true, userId };
}

// GET /admin/staff/:userId/activity
export async function listStaffActivity(actor, userId, { limit, cursor }) {
  const { AuditLog } = await import('../../models/AuditLog.js');
  const target = await User.findById(userId).lean();
  if (!target || target.role === 'USER') throw ApiError.notFound();
  await assertCanManageTargetRole(actor.role, target.role);

  const docs = await AuditLog.find({
    $or: [
      { actorId: userId },
      { targetType: 'USER', targetId: userId, action: { $regex: /^STAFF_/ } },
    ],
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
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata ?? {},
      createdAt: log.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
}

// ---- Self-service 2FA for the signed-in staff member ----

export async function beginTwoFactorSetup(userId) {
  const user = await User.findById(userId).select('+twoFactor.secret +twoFactor.pendingSecret email');
  if (!user || user.role === 'USER') throw ApiError.forbidden();
  if (user.twoFactor?.enabled) throw ApiError.conflict('Two-factor authentication is already enabled.');

  const secret = generateTotpSecret();
  user.twoFactor = { ...(user.twoFactor?.toObject?.() ?? user.twoFactor ?? {}), pendingSecret: secret, enabled: false };
  await user.save();

  return {
    secret,
    otpauthUrl: buildOtpAuthUrl({ secret, email: user.email ?? userId }),
  };
}

export async function confirmTwoFactorSetup(userId, { code }) {
  const user = await User.findById(userId).select('+twoFactor.pendingSecret +twoFactor.secret +twoFactor.backupCodes');
  if (!user?.twoFactor?.pendingSecret) throw ApiError.conflict('Start 2FA setup first.');
  if (!verifyTotp(user.twoFactor.pendingSecret, code)) {
    throw ApiError.validation([{ field: 'code', reason: 'INVALID' }]);
  }

  const backupCodes = generateBackupCodes();
  user.twoFactor.secret = user.twoFactor.pendingSecret;
  user.twoFactor.pendingSecret = undefined;
  user.twoFactor.enabled = true;
  user.twoFactor.verifiedAt = new Date();
  user.twoFactor.backupCodes = backupCodes.map((item) => hashBackupCode(item));
  await user.save();

  await recordAudit(
    { id: userId, role: user.role },
    { action: 'STAFF_2FA_ENABLED', targetType: 'USER', targetId: userId, metadata: {} },
  );

  return { enabled: true, backupCodes };
}

export async function disableTwoFactor(userId, { code }) {
  const user = await User.findById(userId).select('+twoFactor.secret +twoFactor.backupCodes');
  if (!user?.twoFactor?.enabled) throw ApiError.conflict('Two-factor authentication is not enabled.');
  await assertStaffTwoFactor({ id: userId, role: user.role }, code);

  user.twoFactor = { enabled: false };
  await user.save();

  await recordAudit(
    { id: userId, role: user.role },
    { action: 'STAFF_2FA_DISABLED', targetType: 'USER', targetId: userId, metadata: {} },
  );

  return { enabled: false };
}
