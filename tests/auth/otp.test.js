// Tests phone sign-in with the temporary fixed OTP: request, verify, expiry, attempt limits and rate limits.

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { OtpSession } from '../../src/models/OtpSession.js';
import { User } from '../../src/models/User.js';
import { nextPhoneNumber, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

// Requests a code for a phone number.
function requestCode(phoneNumber) {
  return request(app).post('/api/v1/auth/otp/request').send({ phoneNumber });
}

// Verifies a code for a phone number.
function verifyCode(phoneNumber, code) {
  return request(app).post('/api/v1/auth/otp/verify').send({ phoneNumber, code });
}

describe('POST /auth/otp/request', () => {
  useTestDatabase();

  it('creates an OTP session without sending or returning the code', async () => {
    const phoneNumber = nextPhoneNumber();
    const res = await requestCode(phoneNumber);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });
    expect(JSON.stringify(res.body)).not.toContain('123456');

    const session = await OtpSession.findOne({ phoneNumber });
    expect(session.status).toBe('ACTIVE');
    expect(session.failedAttempts).toBe(0);
    expect(session.codeHash).not.toContain('123456');
    expect(session.expiresAt.getTime() - session.requestedAt.getTime()).toBe(300_000);
  });

  it.each([undefined, '9876543210', '+0123456789', '+91 98765 43210'])('rejects phone number %j', async (phoneNumber) => {
    const res = await requestCode(phoneNumber);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('phoneNumber');
  });

  it('enforces the resend cooldown with Retry-After', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    const res = await requestCode(phoneNumber);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('allows 3 requests per 10 minutes per phone', async () => {
    const phoneNumber = nextPhoneNumber();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await OtpSession.deleteMany({ phoneNumber });
      expect((await requestCode(phoneNumber)).status).toBe(200);
    }
    await OtpSession.deleteMany({ phoneNumber });
    const res = await requestCode(phoneNumber);
    expect(res.status).toBe(429);
  });

  it('allows 20 requests per hour per IP', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await requestCode(nextPhoneNumber())).status).toBe(200);
    }
    expect((await requestCode(nextPhoneNumber())).status).toBe(429);
  });
});

describe('POST /auth/otp/verify', () => {
  useTestDatabase();

  it('signs in a new account with 123456 and issues tokens', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    const res = await verifyCode(phoneNumber, '123456');

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(true);
    expect(res.body.data.user).toEqual({ id: expect.stringMatching(/^usr_/), onboardingComplete: false, role: 'USER' });
    expect(res.body.data.tokens).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^rt_/),
      expiresIn: 900,
    });

    const payload = jwt.decode(res.body.data.tokens.accessToken);
    expect(payload.sub).toBe(res.body.data.user.id);
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('signs in an existing account with isNewUser false', async () => {
    const phoneNumber = nextPhoneNumber();
    const existing = await User.create({ phoneNumber, onboardingComplete: true });
    await requestCode(phoneNumber);
    const res = await verifyCode(phoneNumber, '123456');

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(false);
    expect(res.body.data.user).toMatchObject({ id: existing._id, onboardingComplete: true });
  });

  it('returns OTP_INVALID for a wrong code', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    const res = await verifyCode(phoneNumber, '654321');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('returns OTP_EXPIRED when no code was requested', async () => {
    const res = await verifyCode(nextPhoneNumber(), '123456');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('returns OTP_EXPIRED after the code expires', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    await OtpSession.updateOne({ phoneNumber }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verifyCode(phoneNumber, '123456');
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('accepts a code only once', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    expect((await verifyCode(phoneNumber, '123456')).status).toBe(200);
    expect((await verifyCode(phoneNumber, '123456')).body.error.code).toBe('OTP_EXPIRED');
  });

  it('locks the code after five wrong attempts', async () => {
    const phoneNumber = nextPhoneNumber();
    await requestCode(phoneNumber);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await verifyCode(phoneNumber, '000001')).body.error.code).toBe('OTP_INVALID');
    }
    const res = await verifyCode(phoneNumber, '123456');
    expect(res.body.error.code).toBe('OTP_EXPIRED');
    expect((await OtpSession.findOne({ phoneNumber })).status).toBe('LOCKED');
  });

  it('allows 10 verify attempts per 10 minutes per phone', async () => {
    const phoneNumber = nextPhoneNumber();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await verifyCode(phoneNumber, '000001');
    }
    expect((await verifyCode(phoneNumber, '123456')).status).toBe(429);
  });

  it('rejects banned accounts with ACCOUNT_INELIGIBLE', async () => {
    const phoneNumber = nextPhoneNumber();
    await User.create({ phoneNumber, status: 'BANNED' });
    await requestCode(phoneNumber);
    const res = await verifyCode(phoneNumber, '123456');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INELIGIBLE');
  });

  it('validates the code format', async () => {
    const res = await verifyCode(nextPhoneNumber(), '12ab');
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'code', reason: 'INVALID_FORMAT' }]);
  });
});
