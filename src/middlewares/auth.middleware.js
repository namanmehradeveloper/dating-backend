// Authentication and role checks. The user's identity always comes from the verified JWT,
// and the role and account status are always re-read from MongoDB, never trusted from the token.

import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { assertAccountUsable } from '../services/accountStatus.service.js';
import {
  ensureSystemRoles,
  flattenPermissions,
  getPermissionsForRole,
  getRankForRole,
  isAdminTier,
  isStaffRole,
} from '../services/rbac.service.js';
import { verifyAccessToken } from '../services/token.service.js';

const LAST_ACTIVE_REFRESH_MS = 5 * 60 * 1000;

// Reads the token from "Authorization: Bearer <token>". Returns null when the header is missing or malformed.
function readBearerToken(req) {
  const header = req.get('Authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

// Updates lastActiveAt at most every five minutes so each request does not write to MongoDB.
async function touchLastActive(user) {
  const lastActive = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
  if (Date.now() - lastActive < LAST_ACTIVE_REFRESH_MS) return;
  await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } });
}

// Verifies an access token and returns the user it belongs to. Shared by REST and Socket.IO.
export async function authenticateAccessToken(token) {
  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthenticated();
  if ((payload.sv ?? 0) !== (user.sessionVersion ?? 0)) throw ApiError.unauthenticated();
  await assertAccountUsable(user);
  return { user, tokenExpiresAt: new Date(payload.exp * 1000) };
}

// Verifies the access token and attaches the authenticated user to req.user.
export async function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) throw ApiError.unauthenticated();

  const { user } = await authenticateAccessToken(token);
  await touchLastActive(user);

  req.user = {
    id: user._id,
    role: user.role,
    status: user.status,
    onboardingComplete: user.onboardingComplete,
    deletion: user.deletion,
    twoFactorEnabled: Boolean(user.twoFactor?.enabled),
  };
  next();
}

// Allows the request only when the signed-in user's role (from the database) is in `allowedRoles`.
// SUPER_ADMIN satisfies any gate that lists ADMIN (admin-tier inheritance).
export function requireRole(...allowedRoles) {
  return function checkRole(req, res, next) {
    if (!req.user) throw ApiError.unauthenticated();
    if (allowedRoles.includes(req.user.role)) return next();
    if (allowedRoles.includes('ADMIN') && req.user.role === 'SUPER_ADMIN') return next();
    throw ApiError.forbidden();
  };
}

// Any active staff role (system or custom).
export async function requireStaff(req, res, next) {
  if (!req.user) throw ApiError.unauthenticated();
  await ensureSystemRoles();
  if (!(await isStaffRole(req.user.role))) throw ApiError.forbidden();
  const permissions = await getPermissionsForRole(req.user.role);
  req.user.permissions = permissions;
  req.user.permissionKeys = flattenPermissions(permissions);
  req.user.rank = await getRankForRole(req.user.role);
  req.user.isAdminTier = isAdminTier(req.user.role);
  next();
}

// ADMIN and SUPER_ADMIN (and any future role with rank >= ADMIN).
export function requireMinRank(minRole) {
  return async function checkMinRank(req, res, next) {
    if (!req.user) throw ApiError.unauthenticated();
    const [userRank, minRank] = await Promise.all([getRankForRole(req.user.role), getRankForRole(minRole)]);
    if (userRank < minRank) throw ApiError.forbidden();
    next();
  };
}
