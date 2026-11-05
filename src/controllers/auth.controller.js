// HTTP handlers for /auth: validate the body, call the auth services, send the envelope.

import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import * as authService from '../services/auth.service.js';
import { requestOtp } from '../services/otp.service.js';
import { rotateRefreshToken } from '../services/token.service.js';
import { recordLoginActivity } from '../services/loginHistory.service.js';
import { logger } from '../utils/logger.js';
import {
  SOCIAL_PROVIDERS,
  validateLogin,
  validateOtpRequest,
  validateOtpVerify,
  validateRefreshToken,
  validateRegister,
  validateSocialSignIn,
  validateTwoFactorLogin,
} from '../validators/auth.validator.js';

async function trackLogin(req, userId) {
  try {
    await recordLoginActivity(userId, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  } catch (error) {
    logger.error('Failed to save login activity', { userId, error: error.message });
  }
}

// POST /auth/otp/request — starts a sign-in code session (no SMS in fixed mode).
export async function requestOtpCode(req, res) {
  const { phoneNumber } = validateOtpRequest(req.body);
  const result = await requestOtp(phoneNumber);
  return ApiResponse.ok(res, result);
}

// POST /auth/otp/verify — checks the code and returns tokens.
export async function verifyOtpCode(req, res) {
  const input = validateOtpVerify(req.body);
  const result = await authService.signInWithOtp(input);
  await trackLogin(req, result.user.id);
  return ApiResponse.ok(res, result);
}

// POST /auth/token/refresh — rotates the refresh token.
export async function refreshTokens(req, res) {
  const { refreshToken } = validateRefreshToken(req.body);
  const tokens = await rotateRefreshToken(refreshToken);
  return ApiResponse.ok(res, tokens);
}

// POST /auth/logout — revokes the refresh token.
export async function logout(req, res) {
  const { refreshToken } = validateRefreshToken(req.body);
  await authService.signOut(req.user.id, refreshToken);
  return ApiResponse.ok(res, null);
}

// POST /auth/logout-all — signs the member out of every device.
export async function logoutAll(req, res) {
  await authService.signOutEverywhere(req.user.id);
  return ApiResponse.ok(res, null);
}

// POST /auth/register — creates an email/password member account.
export async function register(req, res) {
  const input = validateRegister(req.body);
  const result = await authService.registerWithEmail(input);
  return ApiResponse.created(res, result);
}

// POST /auth/login — email/password sign-in (members and admin panel staff).
export async function login(req, res) {
  const input = validateLogin(req.body);
  const result = await authService.signInWithEmail(input);
  await trackLogin(req, result.user.id);
  return ApiResponse.ok(res, result);
}

// POST /auth/login/2fa — complete staff login after TOTP / backup code.
export async function loginWithTwoFactor(req, res) {
  const input = validateTwoFactorLogin(req.body);
  const result = await authService.completeTwoFactorLogin(input);
  await trackLogin(req, result.user.id);
  return ApiResponse.ok(res, result);
}

// POST /auth/social/:provider — Apple/Google sign-in (not configured yet).
export async function socialSignIn(req, res) {
  if (!SOCIAL_PROVIDERS.includes(req.params.provider)) throw ApiError.notFound();
  validateSocialSignIn(req.body);
  const result = await authService.signInWithSocialProvider(req.params.provider);
  return ApiResponse.ok(res, result);
}
