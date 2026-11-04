// Phone sign-in codes. TEMPORARY: with OTP_MODE=fixed every code is FIXED_OTP (123456 locally)
// and no SMS is sent. Sessions still expire, have a resend cooldown and allow five wrong attempts.

import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { OtpSession } from '../models/OtpSession.js';
import { ApiError } from '../utils/ApiError.js';

export const MAX_FAILED_ATTEMPTS = 5;
const PURGE_DELAY_MS = 24 * 60 * 60 * 1000;

// Hashes a code together with its phone number so the database never holds a usable code.
function hashCode(phoneNumber, code) {
  return crypto.createHmac('sha256', env.jwtRefreshSecret).update(`${phoneNumber}:${code}`).digest('hex');
}

// Compares two hashes in constant time.
function hashesMatch(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

// Produces the code for a new session. Only the fixed development mode exists for now; a real
// SMS provider is not integrated, so OTP_MODE=sms reports FEATURE_NOT_CONFIGURED.
function createCode() {
  if (env.otpMode === 'fixed') return env.fixedOtp;
  throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'SMS sign-in is not available yet.' });
}

// Throws RATE_LIMITED when the previous code was requested less than OTP_RESEND_SECONDS ago.
function assertResendAllowed(session, now) {
  if (!session || session.status !== 'ACTIVE') return;

  const resendAt = session.requestedAt.getTime() + env.otpResendSeconds * 1000;
  if (now.getTime() < resendAt) {
    const waitSeconds = Math.ceil((resendAt - now.getTime()) / 1000);
    throw ApiError.rateLimited(waitSeconds, 'Please wait before requesting another code.');
  }
}

// Starts (or restarts) the sign-in code session for a phone number. Nothing is sent by SMS in fixed mode,
// and the response never contains the code or reveals whether the number is registered.
export async function requestOtp(phoneNumber) {
  const now = new Date();
  const existing = await OtpSession.findOne({ phoneNumber });
  assertResendAllowed(existing, now);

  const code = createCode();
  const expiresAt = new Date(now.getTime() + env.otpExpirySeconds * 1000);

  await OtpSession.findOneAndUpdate(
    { phoneNumber },
    {
      $set: {
        codeHash: hashCode(phoneNumber, code),
        requestedAt: now,
        expiresAt,
        failedAttempts: 0,
        status: 'ACTIVE',
        purgeAt: new Date(expiresAt.getTime() + PURGE_DELAY_MS),
      },
      $unset: { usedAt: 1 },
    },
    { upsert: true },
  );

  return { expiresInSeconds: env.otpExpirySeconds, resendAfterSeconds: env.otpResendSeconds };
}

// Records a wrong code. The fifth wrong attempt locks the session, so later attempts get OTP_EXPIRED.
async function recordFailedAttempt(session) {
  const updated = await OtpSession.findOneAndUpdate(
    { _id: session._id, status: 'ACTIVE' },
    { $inc: { failedAttempts: 1 } },
    { returnDocument: 'after' },
  );
  if (updated && updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await OtpSession.updateOne({ _id: session._id }, { $set: { status: 'LOCKED' } });
  }
}

// Checks the code for a phone number and marks the session used so it works only once.
// Throws OTP_EXPIRED (missing, expired, used or locked) or OTP_INVALID (wrong code).
export async function verifyOtp(phoneNumber, code) {
  const session = await OtpSession.findOne({ phoneNumber });
  const isUsable = session && session.status === 'ACTIVE' && session.expiresAt > new Date();
  if (!isUsable) throw new ApiError('OTP_EXPIRED');

  if (!hashesMatch(session.codeHash, hashCode(phoneNumber, code))) {
    await recordFailedAttempt(session);
    throw new ApiError('OTP_INVALID');
  }

  const used = await OtpSession.findOneAndUpdate(
    { _id: session._id, status: 'ACTIVE' },
    { $set: { status: 'USED', usedAt: new Date() } },
  );
  if (!used) throw new ApiError('OTP_EXPIRED');
}
