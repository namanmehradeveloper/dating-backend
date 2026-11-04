// Tests refresh-token rotation, reuse detection, logout and the requireAuth/requireRole middleware.

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Device } from '../../src/models/Device.js';
import { RefreshToken } from '../../src/models/RefreshToken.js';
import { User } from '../../src/models/User.js';
import { requireAuth, requireRole } from '../../src/middlewares/auth.middleware.js';
import { errorHandler } from '../../src/middlewares/error.middleware.js';
import { requestId } from '../../src/middlewares/requestId.middleware.js';
import { bearer, createMember, nextPhoneNumber, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

// Signs in through OTP and returns the AuthResult data.
async function signIn(phoneNumber = nextPhoneNumber()) {
  await request(app).post('/api/v1/auth/otp/request').send({ phoneNumber });
  const res = await request(app).post('/api/v1/auth/otp/verify').send({ phoneNumber, code: '123456' });
  return res.body.data;
}

// Calls the refresh endpoint.
function refresh(refreshToken) {
  return request(app).post('/api/v1/auth/token/refresh').send({ refreshToken });
}

describe('refresh tokens', () => {
  useTestDatabase();

  it('stores only a hash of the refresh token', async () => {
    const { tokens } = await signIn();
    const stored = await RefreshToken.find();
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toBe(tokens.refreshToken);
    expect(JSON.stringify(stored)).not.toContain(tokens.refreshToken);
  });

  it('rotates the refresh token', async () => {
    const { tokens } = await signIn();
    const res = await refresh(tokens.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(res.body.data.refreshToken).not.toBe(tokens.refreshToken);
    expect((await refresh(res.body.data.refreshToken)).status).toBe(200);
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const { tokens } = await signIn();
    const rotated = (await refresh(tokens.refreshToken)).body.data;

    const reuse = await refresh(tokens.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('UNAUTHENTICATED');

    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    const revoked = await RefreshToken.find({ revokedReason: 'REUSE_DETECTED' });
    expect(revoked.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    expect((await refresh('rt_unknown')).status).toBe(401);

    const { tokens } = await signIn();
    await RefreshToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it('refuses to refresh a banned account', async () => {
    const { tokens, user } = await signIn();
    await User.updateOne({ _id: user.id }, { $set: { status: 'BANNED' } });
    const res = await refresh(tokens.refreshToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INELIGIBLE');
  });

  it('logout revokes the refresh token', async () => {
    const { tokens } = await signIn();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set(bearer(tokens.accessToken))
      .send({ refreshToken: tokens.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it('logout requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: 'rt_x' });
    expect(res.status).toBe(401);
  });

  it('logout cannot revoke another member\'s token', async () => {
    const first = await signIn();
    const second = await signIn();
    await request(app)
      .post('/api/v1/auth/logout')
      .set(bearer(second.tokens.accessToken))
      .send({ refreshToken: first.tokens.refreshToken });
    expect((await refresh(first.tokens.refreshToken)).status).toBe(200);
  });
});

describe('sign out of all devices', () => {
  useTestDatabase();

  // Signs the same phone number in twice, as two devices would.
  async function signInOnTwoDevices() {
    const phoneNumber = nextPhoneNumber();
    const phone = await signIn(phoneNumber);
    const laptop = await signIn(phoneNumber);
    return { phoneNumber, phone, laptop };
  }

  // Calls POST /auth/logout-all with an access token.
  function logoutAll(accessToken) {
    return request(app).post('/api/v1/auth/logout-all').set(bearer(accessToken));
  }

  it('revokes every refresh token and access token of the member', async () => {
    const { phone, laptop } = await signInOnTwoDevices();
    const rotated = (await refresh(laptop.tokens.refreshToken)).body.data;

    const res = await logoutAll(phone.tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();

    expect((await refresh(phone.tokens.refreshToken)).status).toBe(401);
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    for (const accessToken of [phone.tokens.accessToken, laptop.tokens.accessToken, rotated.accessToken]) {
      const me = await request(app).get('/api/v1/profile/me').set(bearer(accessToken));
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await RefreshToken.countDocuments({ userId: phone.user.id, revokedAt: null })).toBe(0);
    expect(await RefreshToken.countDocuments({ revokedReason: 'LOGOUT_ALL' })).toBeGreaterThan(0);
  });

  it('lets the member sign in again afterwards', async () => {
    const { phoneNumber, phone } = await signInOnTwoDevices();
    await logoutAll(phone.tokens.accessToken);

    const again = await signIn(phoneNumber);
    expect(again.user.id).toBe(phone.user.id);
    expect((await request(app).get('/api/v1/profile/me').set(bearer(again.tokens.accessToken))).status).toBe(200);
    expect((await refresh(again.tokens.refreshToken)).status).toBe(200);
  });

  it('removes the member\'s push devices but nobody else\'s', async () => {
    const { phone } = await signInOnTwoDevices();
    const other = await signIn();
    await Device.create({ userId: phone.user.id, platform: 'ANDROID', pushToken: 'push_phone' });
    await Device.create({ userId: phone.user.id, platform: 'IOS', pushToken: 'push_laptop' });
    await Device.create({ userId: other.user.id, platform: 'IOS', pushToken: 'push_other' });

    await logoutAll(phone.tokens.accessToken);
    expect(await Device.countDocuments({ userId: phone.user.id })).toBe(0);
    expect(await Device.countDocuments({ userId: other.user.id })).toBe(1);
  });

  it('does not touch other members\' sessions', async () => {
    const { phone } = await signInOnTwoDevices();
    const other = await signIn();
    await logoutAll(phone.tokens.accessToken);

    expect((await refresh(other.tokens.refreshToken)).status).toBe(200);
    expect((await request(app).get('/api/v1/profile/me').set(bearer(other.tokens.accessToken))).status).not.toBe(401);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/v1/auth/logout-all')).status).toBe(401);
  });
});

describe('requireAuth and requireRole', () => {
  useTestDatabase();

  // A tiny app with one member route and one admin route to exercise the middleware directly.
  const probe = express();
  probe.use(requestId);
  probe.get('/member', requireAuth, (req, res) => res.json({ id: req.user.id, role: req.user.role }));
  probe.get('/admin', requireAuth, requireRole('ADMIN'), (req, res) => res.json({ ok: true }));
  probe.use(errorHandler);

  it('attaches the user from the token', async () => {
    const member = await createMember();
    const res = await request(probe).get('/member').set(bearer(member.token));
    expect(res.body).toEqual({ id: member.id, role: 'USER' });
  });

  it.each([
    ['missing header', {}],
    ['wrong scheme', { Authorization: 'Token abc' }],
    ['garbage token', { Authorization: 'Bearer abc.def.ghi' }],
  ])('rejects %s with 401', async (_label, headers) => {
    const res = await request(probe).get('/member').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired access token', async () => {
    const member = await createMember();
    const expired = jwt.sign({ role: 'USER', typ: 'access' }, process.env.JWT_ACCESS_SECRET, {
      subject: member.id,
      expiresIn: -10,
    });
    expect((await request(probe).get('/member').set(bearer(expired))).status).toBe(401);
  });

  it('reads the role from the database, not the token claim', async () => {
    const member = await createMember();
    const forged = jwt.sign({ role: 'ADMIN', typ: 'access' }, process.env.JWT_ACCESS_SECRET, { subject: member.id });
    const res = await request(probe).get('/admin').set(bearer(forged));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('blocks suspended accounts and lifts expired suspensions', async () => {
    const member = await createMember({ user: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 60_000) } });
    expect((await request(probe).get('/member').set(bearer(member.token))).body.error.code).toBe('ACCOUNT_INELIGIBLE');

    await User.updateOne({ _id: member.id }, { $set: { suspendedUntil: new Date(Date.now() - 1000) } });
    expect((await request(probe).get('/member').set(bearer(member.token))).status).toBe(200);
    expect((await User.findById(member.id)).status).toBe('ACTIVE');
  });
});
