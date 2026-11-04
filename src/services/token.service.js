// Access tokens (short-lived JWTs) and refresh tokens (random, hashed, single-use, rotated in families).

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { assertAccountUsable } from './accountStatus.service.js';

const JWT_ALGORITHM = 'HS256';

// Signs an access token for the user. The role claim is informational; middleware re-reads it from MongoDB.
// `sv` is the user's session version: the token stops working once "sign out of all devices" raises it.
export function issueAccessToken(user) {
  return jwt.sign({ role: user.role, typ: 'access', sv: user.sessionVersion ?? 0 }, env.jwtAccessSecret, {
    algorithm: JWT_ALGORITHM,
    subject: String(user._id),
    expiresIn: env.accessTokenTtlSeconds,
  });
}

// Verifies an access token and returns its payload. Throws 401 UNAUTHENTICATED when invalid or expired.
export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret, { algorithms: [JWT_ALGORITHM] });
    if (payload.typ !== 'access' || !payload.sub) throw new Error('Wrong token type');
    return payload;
  } catch {
    throw ApiError.unauthenticated('Your session has expired. Please sign in again.');
  }
}

// Hashes a refresh token with the refresh secret; only this hash is stored.
export function hashRefreshToken(token) {
  return crypto.createHmac('sha256', env.jwtRefreshSecret).update(token).digest('hex');
}

// Creates and stores a new refresh token in the given family (a new family for a new sign-in).
async function createRefreshToken(userId, familyId) {
  const token = `rt_${crypto.randomBytes(48).toString('base64url')}`;
  await RefreshToken.create({
    tokenHash: hashRefreshToken(token),
    userId,
    familyId,
    expiresAt: new Date(Date.now() + env.refreshTokenTtlSeconds * 1000),
  });
  return token;
}

// Issues the token pair returned by sign-in and refresh: { accessToken, refreshToken, expiresIn }.
export async function issueSessionTokens(user, familyId = uuidv4()) {
  const refreshToken = await createRefreshToken(user._id, familyId);
  return {
    accessToken: issueAccessToken(user),
    refreshToken,
    expiresIn: env.accessTokenTtlSeconds,
  };
}

// Revokes every token in a family, used when a rotated token is presented again (likely stolen).
async function revokeFamily(familyId, reason) {
  await RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

// Exchanges a refresh token for a new pair. The old token is marked used; presenting a used or
// revoked token again revokes its whole family and returns 401.
export async function rotateRefreshToken(refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) throw ApiError.unauthenticated();

  if (record.usedAt || record.revokedAt) {
    await revokeFamily(record.familyId, 'REUSE_DETECTED');
    throw ApiError.unauthenticated();
  }
  if (record.expiresAt <= new Date()) throw ApiError.unauthenticated();

  // Only one request can mark the token used; a concurrent second use is treated as reuse.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: record._id, usedAt: null, revokedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (!claimed) {
    await revokeFamily(record.familyId, 'REUSE_DETECTED');
    throw ApiError.unauthenticated();
  }

  const user = await User.findById(record.userId);
  if (!user) throw ApiError.unauthenticated();
  await assertAccountUsable(user);

  return issueSessionTokens(user, record.familyId);
}

// Revokes the family of a refresh token, but only when the token belongs to this user.
export async function revokeRefreshToken(refreshToken, userId) {
  const record = await RefreshToken.findOne({ tokenHash: hashRefreshToken(refreshToken), userId });
  if (record) await revokeFamily(record.familyId, 'LOGOUT');
}

// Revokes every refresh token of a user (for example after a ban or account deletion).
export async function revokeAllUserTokens(userId, reason) {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}
