// Sign-in flows: phone OTP, email/password and (not yet configured) Apple/Google.
// Every successful sign-in returns the same AuthResult: { user, isNewUser, tokens }.
// Admin-panel 2FA challenge is disabled for staff email/password login.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Device } from '../models/Device.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { calculateAge, MINIMUM_AGE } from '../utils/age.js';
import { ApiError } from '../utils/ApiError.js';
import { assertAccountUsable } from './accountStatus.service.js';
import { verifyOtp } from './otp.service.js';
import { endUserSockets } from './realtime.service.js';
import { issueSessionTokens, revokeAllUserTokens, revokeRefreshToken } from './token.service.js';
import { hashBackupCode, verifyTotp } from './totp.service.js';

export const BCRYPT_ROUNDS = 12;
// Compared against when an email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dating-cloud-dummy-password', 4);

// Shapes the documented AuthResult. `role` lets the admin panel refuse non-staff accounts.
function buildAuthResult(user, isNewUser, tokens) {
  return {
    user: { id: user._id, onboardingComplete: user.onboardingComplete, role: user.role },
    isNewUser,
    tokens,
  };
}

// Signing in during the 14-day deletion grace period cancels the pending deletion.
async function cancelPendingDeletion(user) {
  if (user.deletion?.status !== 'SCHEDULED') return;
  await User.updateOne({ _id: user._id }, { $set: { deletion: { status: 'NONE' } } });
  user.deletion = { status: 'NONE' };
}

// Runs the checks shared by every sign-in, then issues tokens.
async function completeSignIn(user, isNewUser) {
  await assertAccountUsable(user);
  await cancelPendingDeletion(user);
  await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } });
  const tokens = await issueSessionTokens(user);
  return buildAuthResult(user, isNewUser, tokens);
}

// Finds the account for a phone number, or creates it on first sign-in. A concurrent first
// sign-in for the same number is resolved by the unique phone index.
async function findOrCreatePhoneUser(phoneNumber) {
  const existing = await User.findOne({ phoneNumber });
  if (existing) return { user: existing, isNewUser: false };

  try {
    const user = await User.create({ phoneNumber });
    return { user, isNewUser: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { user: await User.findOne({ phoneNumber }), isNewUser: false };
  }
}

// Verifies the temporary OTP and creates a sign-in session, creating the account on first use.
export async function signInWithOtp({ phoneNumber, code }) {
  await verifyOtp(phoneNumber, code);
  const { user, isNewUser } = await findOrCreatePhoneUser(phoneNumber);
  return completeSignIn(user, isNewUser);
}

// Creates an email/password account (always role USER) with a starter profile, then signs it in.
export async function registerWithEmail({ email, password, displayName, dateOfBirth, acceptedTermsVersion }) {
  if (acceptedTermsVersion !== env.currentTermsVersion) {
    throw ApiError.validation([{ field: 'acceptedTermsVersion', reason: 'NOT_CURRENT' }]);
  }
  if (calculateAge(dateOfBirth) < MINIMUM_AGE) throw new ApiError('ACCOUNT_INELIGIBLE');

  if (await User.exists({ email })) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ email, passwordHash, role: 'USER' });
  await Profile.create({
    userId: user._id,
    displayName,
    dateOfBirth,
    acceptedTermsVersion,
    acceptedTermsAt: new Date(),
  });

  return completeSignIn(user, true);
}

function issueTwoFactorPendingToken(userId) {
  return jwt.sign({ typ: '2fa_pending', sub: String(userId) }, env.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: 5 * 60,
  });
}

function verifyTwoFactorPendingToken(token) {
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] });
    if (payload.typ !== '2fa_pending' || !payload.sub) throw new Error('invalid');
    return payload.sub;
  } catch {
    throw ApiError.unauthenticated('Two-factor challenge expired. Sign in again.');
  }
}

// Signs in with email and password. Wrong email and wrong password give the same 401 answer.
// Admin-panel 2FA challenge is disabled — staff receive tokens after password check.
export async function signInWithEmail({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const isPasswordCorrect = await bcrypt.compare(password, passwordHash);

  if (!user || !user.passwordHash || !isPasswordCorrect) {
    throw ApiError.unauthenticated('Email or password is incorrect.');
  }

  return completeSignIn(user, false);
}

// Completes staff login after a valid TOTP or backup code.
export async function completeTwoFactorLogin({ pendingToken, code }) {
  const userId = verifyTwoFactorPendingToken(pendingToken);
  const user = await User.findById(userId).select('+twoFactor.secret +twoFactor.backupCodes +twoFactor.enabled');
  if (!user?.twoFactor?.enabled) throw ApiError.unauthenticated();

  const trimmed = String(code ?? '').trim();
  let ok = user.twoFactor.secret && verifyTotp(user.twoFactor.secret, trimmed);
  if (!ok) {
    const hashed = hashBackupCode(trimmed.toLowerCase());
    const index = (user.twoFactor.backupCodes ?? []).indexOf(hashed);
    if (index === -1) throw ApiError.unauthenticated('Invalid two-factor code.');
    user.twoFactor.backupCodes.splice(index, 1);
    await user.save();
    ok = true;
  }

  return completeSignIn(user, false);
}

// Apple and Google sign-in need provider credentials that are not configured, so the token is
// never trusted or faked: the request is validated and answered with FEATURE_NOT_CONFIGURED.
export async function signInWithSocialProvider() {
  throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'This sign-in method is not available yet.' });
}

// Signs the member out by revoking their refresh token family.
export async function signOut(userId, refreshToken) {
  await revokeRefreshToken(refreshToken, userId);
}

// Signs the member out of every device, including this one: access tokens stop working at once
// (session version), refresh tokens are revoked, push devices are removed and open sockets are closed.
export async function signOutEverywhere(userId) {
  await User.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
  await Promise.all([revokeAllUserTokens(userId, 'LOGOUT_ALL'), Device.deleteMany({ userId })]);
  endUserSockets(userId);
}
