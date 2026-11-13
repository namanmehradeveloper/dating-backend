// Tests admin settings (safe values only, validated, applied live, audited), the audit log
// endpoints, and the live dashboard counts.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Report } from '../../src/models/Report.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';

const app = createApp();

describe('admin settings', () => {
  useTestDatabase();

  it('returns editable settings and system info without any secret', async () => {
    const admin = await createStaff('ADMIN');
    const res = await request(app).get('/api/v1/admin/settings').set(bearer(admin.token));
    expect(res.body.data.settings.map((setting) => setting.key)).toEqual([
      'freeDailyLikes',
      'freeDailySuperLikes',
      'freeDailyRewinds',
      'swipeAbuseThresholdPerDay',
      'matchExpiryDays',
      'matchInactiveDays',
      'matchAlgorithmVersion',
      'matchFraudNewMatchesPerDay',
      'blockAbuseThresholdPerDay',
      'verificationDailyLimit',
    ]);
    expect(res.body.data.system).toMatchObject({ otpMode: 'fixed', pushNotificationsConfigured: false, storeBillingConfigured: true, paymentProvider: 'demo' });

    const body = JSON.stringify(res.body);
    for (const secret of [env.jwtAccessSecret, env.jwtRefreshSecret, env.mongodbUri, env.fixedOtp]) {
      expect(body).not.toContain(secret);
    }
  });

  it('updates a setting, applies it immediately and audits the change', async () => {
    const admin = await createStaff('ADMIN');
    const res = await request(app).patch('/api/v1/admin/settings').set(bearer(admin.token)).send({ freeDailyLikes: 1 });
    expect(res.body.data.settings.find((setting) => setting.key === 'freeDailyLikes').value).toBe(1);

    const audit = await AuditLog.findOne({ action: 'SETTINGS_UPDATED' });
    expect(audit.metadata).toEqual({ changes: { freeDailyLikes: { from: 50, to: 1 } } });

    const swiper = await createMember();
    expect((await swipe(app, swiper, (await createMember()).id, 'LIKE')).status).toBe(200);
    const overLimit = await swipe(app, swiper, (await createMember()).id, 'LIKE');
    expect(overLimit.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', details: [{ field: 'quota', reason: 'DAILY_LIKES_EXHAUSTED' }] });
  });

  it('rejects unknown keys, out-of-range values and empty updates', async () => {
    const admin = await createStaff('ADMIN');
    const patch = (body) => request(app).patch('/api/v1/admin/settings').set(bearer(admin.token)).send(body);
    expect((await patch({ jwtSecret: 'x' })).body.error.details).toEqual([{ field: 'jwtSecret', reason: 'UNKNOWN_FIELD' }]);
    expect((await patch({ freeDailyLikes: 0 })).body.error.details).toEqual([{ field: 'freeDailyLikes', reason: 'RANGE_1_1000' }]);
    expect((await patch({})).body.error.details).toEqual([{ field: 'body', reason: 'NO_FIELDS' }]);
  });
});

describe('admin audit logs', () => {
  useTestDatabase();

  it('lists entries with the actor, filters them, and shows one entry', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    await request(app).patch(`/api/v1/admin/users/${member.id}/status`).set(bearer(admin.token)).send({ status: 'WARNED', reason: 'Rude' });
    await request(app).patch('/api/v1/admin/settings').set(bearer(admin.token)).send({ freeDailySuperLikes: 2 });

    const all = await request(app).get('/api/v1/admin/audit-logs').set(bearer(admin.token));
    expect(all.body.data.items.map((log) => log.action)).toEqual(['SETTINGS_UPDATED', 'USER_STATUS_CHANGED']);
    expect(all.body.data.items[1]).toMatchObject({ actor: { id: admin.id, displayName: admin.user.email }, actorRole: 'ADMIN', targetId: member.id });
    expect(all.body.data.items[1].relatedUsers[member.id]).toMatchObject({ id: member.id, status: 'WARNED' });
    expect(all.body.data.items[0].relatedUsers).toEqual({});

    const filtered = await request(app).get(`/api/v1/admin/audit-logs?targetId=${member.id}`).set(bearer(admin.token));
    expect(filtered.body.data.items).toHaveLength(1);

    const one = await request(app).get(`/api/v1/admin/audit-logs/${filtered.body.data.items[0].id}`).set(bearer(admin.token));
    expect(one.body.data.action).toBe('USER_STATUS_CHANGED');
    expect((await request(app).get('/api/v1/admin/audit-logs/aud_000000000000000000000000').set(bearer(admin.token))).status).toBe(404);
  });

  it('has no write endpoints', async () => {
    const admin = await createStaff('ADMIN');
    expect((await request(app).delete('/api/v1/admin/audit-logs/aud_000000000000000000000000').set(bearer(admin.token))).status).toBe(404);
  });
});

describe('admin dashboard', () => {
  useTestDatabase();

  it('counts real data', async () => {
    const moderator = await createStaff('MODERATOR');
    const alex = await createMember();
    const avery = await createMember({ user: { status: 'SUSPENDED' } });
    await matchMembers(app, alex, await createMember());
    await Report.create({ reporterId: alex.id, targetType: 'USER', targetId: avery.id, targetUserId: avery.id, reason: 'OTHER' });

    const res = await request(app).get('/api/v1/admin/dashboard').set(bearer(moderator.token));
    expect(res.body.data).toMatchObject({
      users: { total: 3, newToday: 3, suspended: 1, banned: 0 },
      moderation: { openReports: 1, inReviewReports: 0, pendingVerifications: 0, totalReports: 1 },
      matches: { total: 1, active: 1, createdToday: 1 },
      messages: { sentToday: 0 },
      support: { openTickets: 0 },
      subscriptions: { activePremium: 0 },
      revenue: { billingConfigured: true, amount: 0, amountMinor: 0, excludesDemo: true, activePremium: 0 },
    });
    expect(res.body.data.signupsByDay).toHaveLength(7);
    expect(res.body.data.signupsByDay[6]).toEqual({ date: new Date().toISOString().slice(0, 10), count: 3 });

    expect(res.body.data.range).toBe(7);
    expect(res.body.data.trends).toHaveLength(7);
    expect(res.body.data.trends[6]).toEqual({ date: new Date().toISOString().slice(0, 10), signups: 3, matches: 1, messages: 0 });
    expect(res.body.data.breakdowns).toEqual({
      accountStatus: { ACTIVE: 2, SUSPENDED: 1 },
      verificationStatus: { NONE: 3 },
      reportsByReason: { OTHER: 1 },
    });
    expect(res.body.data.recent.users).toHaveLength(3);
    expect(res.body.data.recent.reports).toHaveLength(1);
    expect(res.body.data.recent.reports[0]).toMatchObject({ reason: 'OTHER', status: 'OPEN' });
    expect(res.body.data.recent).toHaveProperty('verifications');
    expect(res.body.data.recent).toHaveProperty('matches');
    expect(res.body.data.recent).toHaveProperty('tickets');
    expect(res.body.data.followUp).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'report',
          reason: 'OTHER',
          targetId: expect.any(String),
          user: expect.objectContaining({ id: avery.id }),
        }),
      ]),
    );
    expect(res.body.data.users).toHaveProperty('activeInRange');
    expect(res.body.data.users).toHaveProperty('onlineNow');
    expect(res.body.data.messages).toHaveProperty('sentInRange');
    expect(res.body.data.matches).toHaveProperty('createdInRange');
    expect(res.body.data.changes).toEqual(
      expect.objectContaining({
        previous: expect.objectContaining({
          newUsers: expect.any(Number),
          activeUsers: expect.any(Number),
          matches: expect.any(Number),
          messages: expect.any(Number),
        }),
      }),
    );
    expect(res.body.data.changes).toHaveProperty('newUsers');
    expect(res.body.data.changes).toHaveProperty('messages');
  });

  it('returns trends for the requested range and falls back to 7 days', async () => {
    const moderator = await createStaff('MODERATOR');

    const month = await request(app).get('/api/v1/admin/dashboard?days=30').set(bearer(moderator.token));
    expect(month.body.data.range).toBe(30);
    expect(month.body.data.trends).toHaveLength(30);
    expect(month.body.data).toHaveProperty('from');
    expect(month.body.data).toHaveProperty('to');

    const invalid = await request(app).get('/api/v1/admin/dashboard?days=1000').set(bearer(moderator.token));
    expect(invalid.body.data.range).toBe(7);
    expect(invalid.body.data.trends).toHaveLength(7);
  });

  it('accepts a custom from/to date window', async () => {
    const moderator = await createStaff('MODERATOR');
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setUTCDate(fromDate.getUTCDate() - 2);
    const from = fromDate.toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/v1/admin/dashboard?from=${from}&to=${to}`)
      .set(bearer(moderator.token));
    expect(res.status).toBe(200);
    expect(res.body.data.from).toBe(from);
    expect(res.body.data.to).toBe(to);
    expect(res.body.data.range).toBe(3);
    expect(res.body.data.trends).toHaveLength(3);

    const bad = await request(app)
      .get(`/api/v1/admin/dashboard?from=${to}&to=${from}`)
      .set(bearer(moderator.token));
    expect(bad.status).toBe(400);
  });
});
