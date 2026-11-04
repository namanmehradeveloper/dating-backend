// Tests role protection on every admin route: no token -> 401, members -> 403, moderators -> 403
// on ADMIN-only routes, and the role is read from the database rather than trusted from the token.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();
const ID = 'usr_000000000000000000000000';

const MODERATOR_ROUTES = [
  ['get', '/admin/me'],
  ['get', '/admin/dashboard'],
  ['get', '/admin/users'],
  ['post', '/admin/users'],
  ['get', `/admin/users/${ID}`],
  ['get', `/admin/users/${ID}/reports`],
  ['get', `/admin/users/${ID}/matches`],
  ['patch', `/admin/users/${ID}/status`],
  ['get', '/admin/reports'],
  ['get', '/admin/reports/rep_000000000000000000000000'],
  ['patch', '/admin/reports/rep_000000000000000000000000'],
  ['get', '/admin/verifications'],
  ['get', '/admin/verifications/ver_000000000000000000000000'],
  ['patch', '/admin/verifications/ver_000000000000000000000000'],
  ['get', '/admin/support/tickets'],
  ['get', '/admin/support/tickets/tkt_000000000000000000000000'],
  ['patch', '/admin/support/tickets/tkt_000000000000000000000000'],
  ['post', '/admin/support/tickets/tkt_000000000000000000000000/messages'],
  ['get', '/admin/notifications'],
  ['get', '/admin/profiles'],
  ['get', '/admin/profiles/stats'],
  ['get', '/admin/profiles/photo-queue'],
  ['get', `/admin/profiles/${ID}`],
  ['get', `/admin/profiles/${ID}/history`],
  ['patch', `/admin/profiles/${ID}`],
  ['patch', `/admin/profiles/${ID}/visibility`],
  ['patch', `/admin/profiles/${ID}/boost`],
  ['patch', `/admin/profiles/${ID}/privacy`],
];

const ADMIN_ONLY_ROUTES = [
  ['get', '/admin/subscriptions'],
  ['get', `/admin/subscriptions/${ID}`],
  ['post', '/admin/notifications'],
  ['get', '/admin/audit-logs'],
  ['get', '/admin/audit-logs/aud_000000000000000000000000'],
  ['get', '/admin/settings'],
  ['patch', '/admin/settings'],
];

// Calls one admin route with an optional token.
function call([method, path], token) {
  const req = request(app)[method](`/api/v1${path}`);
  return token ? req.set(bearer(token)) : req;
}

describe('admin access control', () => {
  useTestDatabase();

  it.each([...MODERATOR_ROUTES, ...ADMIN_ONLY_ROUTES])('%s %s needs a token', async (method, path) => {
    expect((await call([method, path])).status).toBe(401);
  });

  it('rejects members on every admin route', async () => {
    const member = await createMember();
    for (const route of [...MODERATOR_ROUTES, ...ADMIN_ONLY_ROUTES]) {
      const res = await call(route, member.token);
      expect(res.status, route.join(' ')).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('lets moderators in, except on ADMIN-only routes', async () => {
    const moderator = await createStaff('MODERATOR');
    for (const route of MODERATOR_ROUTES) {
      expect((await call(route, moderator.token)).status, route.join(' ')).not.toBe(403);
    }
    for (const route of ADMIN_ONLY_ROUTES) {
      expect((await call(route, moderator.token)).status, route.join(' ')).toBe(403);
    }
  });

  it('lets admins use every route', async () => {
    const admin = await createStaff('ADMIN');
    for (const route of [...MODERATOR_ROUTES, ...ADMIN_ONLY_ROUTES]) {
      expect((await call(route, admin.token)).status, route.join(' ')).not.toBe(403);
    }
  });

  it('ignores a forged ADMIN role claim in the token', async () => {
    const member = await createMember();
    const forged = jwt.sign({ role: 'ADMIN', typ: 'access' }, env.jwtAccessSecret, { algorithm: 'HS256', subject: member.id, expiresIn: 60 });
    expect((await call(['get', '/admin/dashboard'], forged)).status).toBe(403);
  });

  it('applies a demotion immediately, without waiting for the token to expire', async () => {
    const moderator = await createStaff('MODERATOR');
    await User.updateOne({ _id: moderator.id }, { role: 'USER' });
    expect((await call(['get', '/admin/dashboard'], moderator.token)).status).toBe(403);
  });

  it('returns the staff session from /admin/me', async () => {
    const admin = await createStaff('ADMIN');
    const res = await call(['get', '/admin/me'], admin.token);
    expect(res.body.data).toMatchObject({
      id: admin.id,
      email: admin.user.email,
      role: 'ADMIN',
      status: 'ACTIVE',
      isAdminTier: true,
      twoFactorEnabled: false,
      createdAt: expect.any(String),
    });
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
  });
});
