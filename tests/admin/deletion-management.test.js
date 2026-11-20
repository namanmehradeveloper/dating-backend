// Deletion Management ledger: stats, tabs, detail, login cancel, retry, admin cancel, force purge,
// Super Admin staff scheduling and last-Super-Admin protections.

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { purgeDueAccounts } from '../../src/jobs/accountDeletion.job.js';
import { AccountDeletionRecord } from '../../src/models/AccountDeletionRecord.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { User } from '../../src/models/User.js';
import { env } from '../../src/config/env.js';
import * as mediaService from '../../src/services/media.service.js';
import { ensureSystemRoles } from '../../src/services/rbac.service.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('admin deletion management', () => {
  useTestDatabase();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires DELETION_MANAGEMENT.VIEW and masks contact for moderators', async () => {
    await ensureSystemRoles();
    const finance = await createStaff('FINANCE_MANAGER');
    const moderator = await createStaff('MODERATOR');
    const admin = await createStaff('ADMIN');
    const member = await createMember({
      profile: { displayName: 'Ledger Face' },
      user: { email: 'ledger@example.test' },
    });

    expect((await request(app).get('/api/v1/admin/deletion-management/stats').set(bearer(finance.token))).status).toBe(
      403,
    );

    await request(app)
      .post(`/api/v1/admin/users/${member.id}/deletion`)
      .set(bearer(admin.token))
      .send({ reason: 'Abuse confirmed' });

    const list = await request(app)
      .get('/api/v1/admin/deletion-management?tab=scheduled')
      .set(bearer(moderator.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items[0].email).toMatch(/\*\*\*/);
    expect(list.body.data.items[0].displayName).toBe('Ledger Face');
    expect(list.body.data.items[0].scheduledBy?.id).toBe(admin.id);
  });

  it('tracks schedule → login cancel → reschedule → purge with surviving audits', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'Gone Soon' } });

    const scheduled = await request(app)
      .post(`/api/v1/admin/users/${member.id}/deletion`)
      .set(bearer(admin.token))
      .send({ reason: 'Policy violation' });
    expect(scheduled.status).toBe(202);

    const stats = await request(app).get('/api/v1/admin/deletion-management/stats').set(bearer(admin.token));
    expect(stats.body.data.scheduled).toBeGreaterThanOrEqual(1);

    const open = await AccountDeletionRecord.findOne({ userId: member.id, status: 'SCHEDULED' }).lean();
    expect(open).toMatchObject({ source: 'ADMIN', reason: 'Policy violation', scheduledByAdminId: admin.id });

    await request(app).post('/api/v1/auth/otp/request').send({ phoneNumber: member.user.phoneNumber });
    await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: member.user.phoneNumber, code: env.fixedOtp });
    expect((await User.findById(member.id)).deletion.status).toBe('NONE');
    expect((await AccountDeletionRecord.findById(open._id)).status).toBe('CANCELLED');

    await request(app)
      .post(`/api/v1/admin/users/${member.id}/deletion`)
      .set(bearer(admin.token))
      .send({ reason: 'Second schedule' });

    const result = await purgeDueAccounts(new Date(Date.now() + 15 * 86400000));
    expect(result.erased).toBe(1);
    expect(await User.exists({ _id: member.id })).toBeNull();

    const purged = await AccountDeletionRecord.findOne({ userId: member.id, status: 'PURGED' }).lean();
    expect(purged).toBeTruthy();
    expect(purged.displayNameSnapshot).toBe('Gone Soon');

    expect(await AuditLog.exists({ action: 'USER_DELETION_SCHEDULED', targetId: member.id })).toBeTruthy();
    expect(await AuditLog.exists({ action: 'USER_DELETION_PURGED', targetId: member.id })).toBeTruthy();

    const history = await request(app)
      .get('/api/v1/admin/deletion-management?tab=purged')
      .set(bearer(admin.token));
    expect(history.body.data.items.some((row) => row.userId === member.id)).toBe(true);

    const detail = await request(app)
      .get(`/api/v1/admin/deletion-management/${purged._id}`)
      .set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.liveAccount).toBeNull();
    expect(detail.body.data.auditTrail.length).toBeGreaterThan(0);
    expect(detail.body.data.canRetry).toBe(false);
  });

  it('isolates per-user purge failures and allows authorized retry', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const okMember = await createMember({ profile: { displayName: 'Ok Purge' } });
    const badMember = await createMember({ profile: { displayName: 'Bad Purge' } });

    for (const member of [okMember, badMember]) {
      await request(app)
        .post(`/api/v1/admin/users/${member.id}/deletion`)
        .set(bearer(admin.token))
        .send({ reason: 'Cleanup batch' });
    }

    vi.spyOn(mediaService, 'removeMediaFile').mockImplementation(async () => {});
    const endMatches = await import('../../src/services/match.service.js');
    vi.spyOn(endMatches, 'endAllMatchesForUser').mockImplementation(async (userId) => {
      if (userId === badMember.id) throw new Error('Simulated purge failure');
    });

    const result = await purgeDueAccounts(new Date(Date.now() + 15 * 86400000));
    expect(result.erased).toBe(1);
    expect(result.failed).toBe(1);
    expect(await User.exists({ _id: okMember.id })).toBeNull();
    expect(await User.exists({ _id: badMember.id })).toBeTruthy();
    expect(await AccountDeletionRecord.findOne({ userId: badMember.id })).toMatchObject({
      status: 'FAILED',
      lastError: 'Simulated purge failure',
    });

    const failedRecord = await AccountDeletionRecord.findOne({ userId: badMember.id, status: 'FAILED' }).lean();
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/deletion-management/${failedRecord._id}/retry`)
          .set(bearer(moderator.token))
      ).status,
    ).toBe(403);

    await User.updateOne({ _id: badMember.id }, { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } });
    vi.spyOn(endMatches, 'endAllMatchesForUser').mockResolvedValue(undefined);

    const retried = await request(app)
      .post(`/api/v1/admin/deletion-management/${failedRecord._id}/retry`)
      .set(bearer(admin.token));
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe('PURGED');
    expect(await User.exists({ _id: badMember.id })).toBeNull();
    expect(await AuditLog.exists({ action: 'USER_DELETION_PURGE_RETRIED', targetId: badMember.id })).toBeTruthy();
  });

  it('lets Super Admin schedule staff deletion and blocks Admin and self', async () => {
    await ensureSystemRoles();
    const superAdmin = await createStaff('SUPER_ADMIN');
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');

    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${moderator.id}/deletion`)
          .set(bearer(admin.token))
          .send({ reason: 'Staff offboard' })
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${superAdmin.id}/deletion`)
          .set(bearer(superAdmin.token))
          .send({ reason: 'Cannot delete self' })
      ).status,
    ).toBe(403);

    const scheduled = await request(app)
      .post(`/api/v1/admin/users/${moderator.id}/deletion`)
      .set(bearer(superAdmin.token))
      .send({ reason: 'Staff offboard' });
    expect(scheduled.status).toBe(202);
    expect(scheduled.body.data.graceDays).toBe(14);
    expect(scheduled.body.data.role).toBe('MODERATOR');

    const ledger = await AccountDeletionRecord.findOne({ userId: moderator.id, status: 'SCHEDULED' }).lean();
    expect(ledger).toMatchObject({ source: 'ADMIN', scheduledByAdminId: superAdmin.id });

    const list = await request(app)
      .get('/api/v1/admin/deletion-management?tab=scheduled')
      .set(bearer(superAdmin.token));
    expect(list.body.data.items.some((row) => row.userId === moderator.id)).toBe(true);
  });

  it('blocks demotion, hard-delete and schedule of the last active Super Admin', async () => {
    await ensureSystemRoles();
    await User.updateMany({ role: 'SUPER_ADMIN' }, { $set: { role: 'ADMIN' } });

    const a = await createStaff('SUPER_ADMIN');
    const b = await createStaff('SUPER_ADMIN');
    const admin = await createStaff('ADMIN');

    expect(
      (await request(app).patch(`/api/v1/admin/staff/${a.id}/role`).set(bearer(a.token)).send({ role: 'ADMIN' })).status,
    ).toBe(403);
    expect(
      (await request(app).post(`/api/v1/admin/users/${a.id}/deletion`).set(bearer(a.token)).send({ reason: 'Self' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`/api/v1/admin/staff/${a.id}`).set(bearer(a.token))).status).toBe(403);

    expect(
      (await request(app).patch(`/api/v1/admin/staff/${a.id}/role`).set(bearer(admin.token)).send({ role: 'ADMIN' }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${a.id}/deletion`)
          .set(bearer(admin.token))
          .send({ reason: 'Admin vs SA' })
      ).status,
    ).toBe(403);

    // Two Super Admins: demote / delete / schedule of the peer is allowed.
    expect(
      (await request(app).patch(`/api/v1/admin/staff/${b.id}/role`).set(bearer(a.token)).send({ role: 'ADMIN' })).status,
    ).toBe(200);

    const c = await createStaff('SUPER_ADMIN');
    expect((await request(app).delete(`/api/v1/admin/staff/${c.id}`).set(bearer(a.token))).status).toBe(200);

    const d = await createStaff('SUPER_ADMIN');
    const scheduled = await request(app)
      .post(`/api/v1/admin/users/${d.id}/deletion`)
      .set(bearer(a.token))
      .send({ reason: 'Peer offboard' });
    expect(scheduled.status).toBe(202);
    const dRecord = await AccountDeletionRecord.findOne({ userId: d.id, status: 'SCHEDULED' }).lean();
    await request(app).post(`/api/v1/admin/deletion-management/${dRecord._id}/cancel`).set(bearer(a.token));

    // Leave a as the only active Super Admin, then use peer to demote a (two SAs), leaving peer alone.
    await User.updateMany({ role: 'SUPER_ADMIN', _id: { $ne: a.id } }, { $set: { role: 'ADMIN' } });
    const peer = await createStaff('SUPER_ADMIN');
    expect(
      (await request(app).patch(`/api/v1/admin/staff/${a.id}/role`).set(bearer(peer.token)).send({ role: 'ADMIN' }))
        .status,
    ).toBe(200);
    await User.updateMany({ role: 'SUPER_ADMIN', _id: { $ne: peer.id } }, { $set: { role: 'ADMIN' } });

    expect(
      (
        await request(app)
          .patch(`/api/v1/admin/staff/${peer.id}/role`)
          .set(bearer(peer.token))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${peer.id}/deletion`)
          .set(bearer(peer.token))
          .send({ reason: 'Last SA' })
      ).status,
    ).toBe(403);
    expect((await request(app).delete(`/api/v1/admin/staff/${peer.id}`).set(bearer(peer.token))).status).toBe(403);
  });

  it('cancels scheduled deletions and force-purges with Super Admin confirmation', async () => {
    await ensureSystemRoles();
    const superAdmin = await createStaff('SUPER_ADMIN');
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'Cancel Me' } });
    const purgeTarget = await createMember({ profile: { displayName: 'Force Purge' } });

    await request(app)
      .post(`/api/v1/admin/users/${member.id}/deletion`)
      .set(bearer(admin.token))
      .send({ reason: 'Will cancel' });
    const scheduled = await AccountDeletionRecord.findOne({ userId: member.id, status: 'SCHEDULED' }).lean();

    expect(
      (
        await request(app)
          .post(`/api/v1/admin/deletion-management/${scheduled._id}/cancel`)
          .set(bearer(admin.token))
      ).status,
    ).toBe(200);
    expect((await User.findById(member.id)).deletion.status).toBe('NONE');
    expect((await AccountDeletionRecord.findById(scheduled._id)).status).toBe('CANCELLED');
    expect(await AuditLog.exists({ action: 'USER_DELETION_CANCELLED', targetId: member.id })).toBeTruthy();

    // Login cancel path still works (unchanged).
    await request(app)
      .post(`/api/v1/admin/users/${member.id}/deletion`)
      .set(bearer(admin.token))
      .send({ reason: 'Login cancel again' });
    await request(app).post('/api/v1/auth/otp/request').send({ phoneNumber: member.user.phoneNumber });
    await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: member.user.phoneNumber, code: env.fixedOtp });
    expect((await User.findById(member.id)).deletion.status).toBe('NONE');

    await request(app)
      .post(`/api/v1/admin/users/${purgeTarget.id}/deletion`)
      .set(bearer(superAdmin.token))
      .send({ reason: 'Force purge candidate' });
    const purgeRecord = await AccountDeletionRecord.findOne({ userId: purgeTarget.id, status: 'SCHEDULED' }).lean();

    const detailBefore = await request(app)
      .get(`/api/v1/admin/deletion-management/${purgeRecord._id}`)
      .set(bearer(superAdmin.token));
    expect(detailBefore.body.data.canForcePurge).toBe(true);
    expect(detailBefore.body.data.canCancel).toBe(true);

    expect(
      (
        await request(app)
          .post(`/api/v1/admin/deletion-management/${purgeRecord._id}/purge`)
          .set(bearer(admin.token))
          .send({ confirm: true })
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .post(`/api/v1/admin/deletion-management/${purgeRecord._id}/purge`)
          .set(bearer(superAdmin.token))
          .send({})
      ).status,
    ).toBe(400);

    const forced = await request(app)
      .post(`/api/v1/admin/deletion-management/${purgeRecord._id}/purge`)
      .set(bearer(superAdmin.token))
      .send({ confirm: true });
    expect(forced.status).toBe(200);
    expect(forced.body.data.status).toBe('PURGED');
    expect(await User.exists({ _id: purgeTarget.id })).toBeNull();
    expect(await AuditLog.exists({ action: 'USER_DELETION_FORCE_PURGED', targetId: purgeTarget.id })).toBeTruthy();

    const detail = await request(app)
      .get(`/api/v1/admin/deletion-management/${purgeRecord._id}`)
      .set(bearer(superAdmin.token));
    expect(detail.body.data.canForcePurge).toBe(false);
    expect(detail.body.data.attempts.some((attempt) => attempt.triggeredBy === 'ADMIN_FORCE')).toBe(true);
  });

  it('blocks force-purge when no other active Super Admin would remain', async () => {
    await ensureSystemRoles();
    await User.updateMany({ role: 'SUPER_ADMIN' }, { $set: { role: 'ADMIN' } });

    const keeper = await createStaff('SUPER_ADMIN');
    const target = await createStaff('SUPER_ADMIN');
    const admin = await createStaff('ADMIN');

    await request(app)
      .post(`/api/v1/admin/users/${target.id}/deletion`)
      .set(bearer(keeper.token))
      .send({ reason: 'Force candidate' });
    const record = await AccountDeletionRecord.findOne({ userId: target.id, status: 'SCHEDULED' }).lean();

    // Admin cannot force purge.
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/deletion-management/${record._id}/purge`)
          .set(bearer(admin.token))
          .send({ confirm: true })
      ).status,
    ).toBe(403);

    // Demote keeper so the only remaining SUPER_ADMIN is the scheduled target.
    await User.updateOne({ _id: keeper.id }, { $set: { role: 'ADMIN' } });
    await User.updateMany({ role: 'SUPER_ADMIN', _id: { $ne: target.id } }, { $set: { role: 'ADMIN' } });

    // Caller must be Super Admin; creating one also provides the surviving SA, so purge is allowed.
    // To hit the last-SA conflict: call the service with a Super Admin while excluding them from
    // the count by demoting them after schedule — use assertNotLastActiveSuperAdmin via demoting
    // the only peer before purge by temporarily having peer, then demoting peer and using
    // includeScheduledTarget with zero others. Import and call the guard directly for the edge case.
    const { assertNotLastActiveSuperAdmin } = await import('../../src/services/rbac.service.js');
    const scheduledTarget = await User.findById(target.id).lean();
    await expect(
      assertNotLastActiveSuperAdmin(scheduledTarget, {
        actionLabel: 'force-purge',
        includeScheduledTarget: true,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/last active Super Admin/i) });

    // With a surviving peer Super Admin, force purge succeeds.
    const peer = await createStaff('SUPER_ADMIN');
    const ok = await request(app)
      .post(`/api/v1/admin/deletion-management/${record._id}/purge`)
      .set(bearer(peer.token))
      .send({ confirm: true });
    expect(ok.status).toBe(200);
    expect(await User.exists({ _id: target.id })).toBeNull();
  });
});

