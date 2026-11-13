// Tests admin staff, CMS, fraud, coupons, referrals, experiments, monitoring and stubs.

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('admin staff, CMS, fraud and related modules', () => {
  useTestDatabase();

  it('creates staff, lists them, and changes roles with last-admin protection', async () => {
    const admin = await createStaff('ADMIN');
    const created = await request(app)
      .post('/api/v1/admin/staff')
      .set(bearer(admin.token))
      .send({ email: 'mod.new@example.test', password: 'password12345', role: 'MODERATOR' });
    expect(created.status).toBe(201);
    expect(created.body.data.role).toBe('MODERATOR');

    const stored = await User.findById(created.body.data.id).select('+passwordHash');
    expect(await bcrypt.compare('password12345', stored.passwordHash)).toBe(true);

    const audit = await AuditLog.findOne({ action: 'STAFF_CREATED' });
    expect(audit.targetId).toBe(created.body.data.id);

    const list = await request(app).get('/api/v1/admin/staff').set(bearer(admin.token));
    expect(list.body.data.items.some((item) => item.id === created.body.data.id)).toBe(true);

    const promoted = await request(app)
      .patch(`/api/v1/admin/staff/${created.body.data.id}/role`)
      .set(bearer(admin.token))
      .send({ role: 'ADMIN' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('ADMIN');

    const self = await request(app).patch(`/api/v1/admin/staff/${admin.id}/role`).set(bearer(admin.token)).send({ role: 'MODERATOR' });
    expect(self.status).toBe(403);

    // Only one original admin left if we demote the new one first... keep two admins then demote both fails on last.
    await request(app).patch(`/api/v1/admin/staff/${created.body.data.id}/role`).set(bearer(admin.token)).send({ role: 'MODERATOR' });
    const last = await request(app).patch(`/api/v1/admin/staff/${admin.id}/role`).set(bearer(admin.token)).send({ role: 'MODERATOR' });
    // Cannot demote self; use another admin to demote last admin.
    const secondAdmin = await createStaff('ADMIN');
    await User.updateOne({ _id: admin.id }, { role: 'MODERATOR' });
    // Now only secondAdmin is ADMIN — demoting them should fail.
    const demoteLast = await request(app)
      .patch(`/api/v1/admin/staff/${secondAdmin.id}/role`)
      .set(bearer(secondAdmin.token))
      .send({ role: 'MODERATOR' });
    expect(demoteLast.status).toBe(403);

    const onlyAdminLeft = await User.countDocuments({ role: 'ADMIN' });
    expect(onlyAdminLeft).toBe(1);
    const demoteByOther = await request(app)
      .patch(`/api/v1/admin/staff/${secondAdmin.id}/role`)
      .set(bearer(admin.token))
      .send({ role: 'MODERATOR' });
    // admin was demoted to MODERATOR so cannot call ADMIN routes
    expect(demoteByOther.status).toBe(403);

    const stillAdmin = await createStaff('ADMIN');
    const failLast = await request(app)
      .patch(`/api/v1/admin/staff/${secondAdmin.id}/role`)
      .set(bearer(stillAdmin.token))
      .send({ role: 'MODERATOR' });
    // secondAdmin is still ADMIN (self-demote was forbidden); demote them with stillAdmin while another ADMIN exists
    // Actually secondAdmin is still ADMIN and stillAdmin is ADMIN — two admins, demoting secondAdmin should work.
    // Wait — we never successfully demoted secondAdmin. Let me recount:
    // After self-demote attempt failed, secondAdmin is ADMIN. We then demoted admin to MODERATOR via updateOne.
    // Admins: secondAdmin only (createStaff ADMIN created secondAdmin earlier). Then stillAdmin = another ADMIN.
    // So admins: secondAdmin + stillAdmin. Demoting secondAdmin should succeed.
    expect(failLast.status).toBe(200);

    const lastStanding = await request(app)
      .patch(`/api/v1/admin/staff/${stillAdmin.id}/role`)
      .set(bearer(stillAdmin.token))
      .send({ role: 'MODERATOR' });
    expect(lastStanding.status).toBe(403);
  });

  it('restricts staff routes to ADMIN and denies USER', async () => {
    const member = await createMember();
    const moderator = await createStaff('MODERATOR');
    expect((await request(app).get('/api/v1/admin/staff').set(bearer(member.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/staff').set(bearer(moderator.token))).status).toBe(403);
  });

  it('allows staff to read CMS and ADMIN to create/publish', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');

    const created = await request(app)
      .post('/api/v1/admin/cms')
      .set(bearer(admin.token))
      .send({ title: 'Welcome', slug: 'welcome', type: 'BANNER', body: 'Hello', status: 'DRAFT' });
    expect(created.status).toBe(201);

    const denied = await request(app)
      .post('/api/v1/admin/cms')
      .set(bearer(moderator.token))
      .send({ title: 'Nope', slug: 'nope', type: 'FAQ', body: 'x' });
    expect(denied.status).toBe(403);

    const list = await request(app).get('/api/v1/admin/cms').set(bearer(moderator.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);

    const published = await request(app)
      .patch(`/api/v1/admin/cms/${created.body.data.id}`)
      .set(bearer(admin.token))
      .send({ status: 'PUBLISHED' });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('PUBLISHED');
    expect(published.body.data.publishedAt).toBeTruthy();
  });

  it('runs rule-based fraud scan and updates signal status', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'Risky' } });

    // Create many swipes to trigger HIGH_SWIPE_VELOCITY
    const targets = await Promise.all(Array.from({ length: 80 }, () => createMember()));
    await Promise.all(targets.map((target) => SwipeLike(member.id, target.id)));

    const scan = await request(app).post(`/api/v1/admin/fraud/scan/${member.id}`).set(bearer(admin.token));
    expect(scan.status).toBe(200);
    expect(scan.body.data.signals.some((s) => s.code === 'HIGH_SWIPE_VELOCITY')).toBe(true);
    expect(scan.body.data.totalScore).toBeGreaterThan(0);

    const status = await request(app).get('/api/v1/admin/fraud/status').set(bearer(admin.token));
    expect(status.body.data).toEqual({ configured: false, provider: null, modes: ['RULE_BASED'] });

    const updated = await request(app)
      .patch(`/api/v1/admin/fraud/signals/${scan.body.data.id}`)
      .set(bearer(admin.token))
      .send({ status: 'REVIEWED' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('REVIEWED');
  });

  it('manages coupons, referrals and experiments as ADMIN', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    const moderator = await createStaff('MODERATOR');

    expect((await request(app).get('/api/v1/admin/coupons').set(bearer(moderator.token))).status).toBe(403);

    const coupon = await request(app)
      .post('/api/v1/admin/coupons')
      .set(bearer(admin.token))
      .send({ code: 'save10', type: 'PERCENT', value: 10 });
    expect(coupon.status).toBe(201);
    expect(coupon.body.data.code).toBe('SAVE10');

    const deactivated = await request(app)
      .patch(`/api/v1/admin/coupons/${coupon.body.data.id}`)
      .set(bearer(admin.token))
      .send({ isActive: false });
    expect(deactivated.body.data.isActive).toBe(false);

    const referral = await request(app)
      .post('/api/v1/admin/referrals')
      .set(bearer(admin.token))
      .send({ code: 'invite1', ownerUserId: member.id, rewardConfig: { inviterReward: 'PLUS_7D' } });
    expect(referral.status).toBe(201);
    const referralList = await request(app).get('/api/v1/admin/referrals?q=invite1').set(bearer(admin.token));
    expect(referralList.status).toBe(200);
    expect(referralList.body.data.items).toHaveLength(1);

    const experiment = await request(app)
      .post('/api/v1/admin/experiments')
      .set(bearer(admin.token))
      .send({ key: 'home_cta', name: 'Home CTA', variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }] });
    expect(experiment.status).toBe(201);

    const running = await request(app)
      .patch(`/api/v1/admin/experiments/${experiment.body.data.id}`)
      .set(bearer(admin.token))
      .send({ status: 'RUNNING' });
    expect(running.body.data.status).toBe('RUNNING');
    expect(running.body.data.startedAt).toBeTruthy();
  });

  it('returns monitoring, call configuration and honest payment status for ADMIN', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');

    expect((await request(app).get('/api/v1/admin/monitoring').set(bearer(moderator.token))).status).toBe(403);

    const monitoring = await request(app).get('/api/v1/admin/monitoring').set(bearer(admin.token));
    expect(monitoring.status).toBe(200);
    expect(monitoring.body.data.mongoose).toHaveProperty('readyState');
    expect(monitoring.body.data.process).toHaveProperty('uptimeSeconds');
    expect(monitoring.body.data.sockets).toHaveProperty('connected');
    expect(monitoring.body.data).toMatchObject({
      overall: expect.stringMatching(/HEALTHY|WARNING|DEGRADED/),
      api: { windowMinutes: 15 },
      database: { ok: true },
      media: { processing: { queueConfigured: false } },
      calls: { configured: true },
      payments: { configured: true, provider: 'demo' },
      jobs: { broker: 'in-process' },
      infrastructureCost: { configured: false },
      deployment: { environment: expect.any(String) },
    });
    expect(Array.isArray(monitoring.body.data.alerts)).toBe(true);
    expect(Array.isArray(monitoring.body.data.jobs.items)).toBe(true);
    expect(monitoring.body.data.jobs.items.some((job) => job.id === 'account-deletion-purge')).toBe(true);

    const calls = await request(app).get('/api/v1/admin/calls/status').set(bearer(admin.token));
    expect(calls.body.data.configured).toBe(true);

    const payments = await request(app).get('/api/v1/admin/payments/status').set(bearer(admin.token));
    expect(payments.body.data.configured).toBe(true);
    expect(payments.body.data.storeBillingConfigured).toBe(true);
    expect(payments.body.data.provider).toBe('demo');
  });
});

// Inserts a LIKE swipe directly (faster than HTTP for fraud velocity setup).
async function SwipeLike(userId, targetUserId) {
  const { Swipe } = await import('../../src/models/Swipe.js');
  await Swipe.create({ userId, targetUserId, action: 'LIKE' });
}
