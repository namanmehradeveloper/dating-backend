// /api/v1/auth routes with their documented rate limits.

import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byIp, createRateLimiter, HOUR, MINUTE } from '../utils/rateLimit.js';

const router = Router();

// Rate-limit key for phone-based limits; the number is read from the JSON body.
const byPhoneNumber = (req) => (typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : undefined);
const byEmail = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : undefined);

const otpRequestPerPhone = createRateLimiter({ windowMs: 10 * MINUTE, max: 3, keyFrom: byPhoneNumber });
const otpRequestPerIp = createRateLimiter({ windowMs: HOUR, max: 20, keyFrom: byIp });
const otpVerifyPerPhone = createRateLimiter({ windowMs: 10 * MINUTE, max: 10, keyFrom: byPhoneNumber });
const refreshPerIp = createRateLimiter({ windowMs: 10 * MINUTE, max: 60, keyFrom: byIp });
const registerPerIp = createRateLimiter({ windowMs: HOUR, max: 10, keyFrom: byIp });
const loginPerEmail = createRateLimiter({ windowMs: 15 * MINUTE, max: 10, keyFrom: byEmail });
const loginPerIp = createRateLimiter({ windowMs: HOUR, max: 100, keyFrom: byIp });
const socialPerIp = createRateLimiter({ windowMs: HOUR, max: 20, keyFrom: byIp });

// POST /api/v1/auth/otp/request — start a phone OTP sign-in session (public; 3 per phone / 10 min, 20 per IP / hour).
router.post('/otp/request', otpRequestPerIp, otpRequestPerPhone, authController.requestOtpCode);

// POST /api/v1/auth/otp/verify — check the OTP code and return access + refresh tokens (public; 10 per phone / 10 min).
router.post('/otp/verify', otpVerifyPerPhone, authController.verifyOtpCode);

// POST /api/v1/auth/token/refresh — rotate the refresh token and issue a new access token (public; 60 per IP / 10 min).
router.post('/token/refresh', refreshPerIp, authController.refreshTokens);

// POST /api/v1/auth/logout — revoke the refresh token (signed-in).
router.post('/logout', requireAuth, authController.logout);

// POST /api/v1/auth/logout-all — sign out of every device: all tokens, push devices and sockets (signed-in).
router.post('/logout-all', requireAuth, authController.logoutAll);

// POST /api/v1/auth/register — create an email/password member account (public; 10 per IP / hour).
router.post('/register', registerPerIp, authController.register);

// POST /api/v1/auth/login — email/password sign-in for members and admin staff (public; 10 per email / 15 min, 100 per IP / hour).
router.post('/login', loginPerIp, loginPerEmail, authController.login);

// POST /api/v1/auth/login/2fa — complete staff login when 2FA is enabled.
router.post('/login/2fa', loginPerIp, authController.loginWithTwoFactor);

// POST /api/v1/auth/social/:provider — Apple/Google sign-in, not configured yet (public; 20 per IP / hour).
router.post('/social/:provider', socialPerIp, authController.socialSignIn);

export default router;
