// Tests admin member search and details (with contact masking for moderators), a member's reports
// and matches, and status changes with their role rules, side effects and audit entries.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Match } from '../../src/models/Match.js';
import { Notification } from '../../src/models/Notification.js';
import { Profile } from '../../src/models/Profile.js';
import { RefreshToken } from '../../src/models/RefreshToken.js';
import { Report } from '../../src/models/Report.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

// Sends PATCH /admin/users/:userId/status.
function changeStatus(staff, userId, body) {
  return request(app).patch(`/api/v1/admin/users/${userId}/status`).set(bearer(staff.token)).send(body);
}

describe('admin users: search and details', () => {
  useTestDatabase();

  it('creates a member by phone with profile fields', async () => {
    const admin = await createStaff('ADMIN');
    const body = {
      phoneNumber: '+15559876001',
      email: 'new.member@example.com',
      displayName: 'Neha',
      dateOfBirth: '1998-05-12',
      gender: 'WOMAN',
      showGender: true,
      relationshipGoal: 'LONG_TERM',
      bio: 'Coffee and weekends',
      city: 'Mumbai',
      occupation: 'Designer',
      status: 'ACTIVE',
      verificationStatus: 'NONE',
      visibilityStatus: 'VISIBLE',
      minAge: 21,
      maxAge: 40,
      maxDistanceKm: 50,
      showMe: 'MEN',
    };

    const res = await request(app).post('/api/v1/admin/users').set(bearer(admin.token)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: expect.stringMatching(/^usr_/),
      displayName: 'Neha',
      phoneNumber: '+15559876001',
      email: 'new.member@example.com',
      status: 'ACTIVE',
      role: 'USER',
      verificationStatus: 'NONE',
    });

    const stored = await User.findById(res.body.data.id);
    expect(stored).toMatchObject({ phoneNumber: '+15559876001', onboardingComplete: true, role: 'USER' });
    expect(await AuditLog.exists({ action: 'USER_CREATED', targetId: res.body.data.id })).toBeTruthy();

    const duplicate = await request(app).post('/api/v1/admin/users').set(bearer(admin.token)).send(body);
    expect(duplicate.status).toBe(409);
  });

  it('searches by name, phone and id, and filters by status', async () => {
    const admin = await createStaff('ADMIN');
    const priya = await createMember({ profile: { displayName: 'Priya' } });
    await createMember({ profile: { displayName: 'Rahul' }, user: { status: 'WARNED' } });

    const byName = await request(app).get('/api/v1/admin/users?q=pri').set(bearer(admin.token));
    expect(byName.body.data.items.map((user) => user.id)).toEqual([priya.id]);

    const byPhone = await request(app).get(`/api/v1/admin/users?q=${encodeURIComponent(priya.user.phoneNumber.slice(-6))}`).set(bearer(admin.token));
    expect(byPhone.body.data.items.map((user) => user.id)).toEqual([priya.id]);

    const byId = await request(app).get(`/api/v1/admin/users?q=${priya.id}`).set(bearer(admin.token));
    expect(byId.body.data.items).toHaveLength(1);

    const warned = await request(app).get('/api/v1/admin/users?status=WARNED&role=USER').set(bearer(admin.token));
    expect(warned.body.data.items.map((user) => user.displayName)).toEqual(['Rahul']);

    const invalid = await request(app).get('/api/v1/admin/users?status=HAPPY').set(bearer(admin.token));
    expect(invalid.body.error.details).toEqual([{ field: 'status', reason: 'UNKNOWN_OPTION' }]);
  });

  it('filters members by gender', async () => {
    const admin = await createStaff('ADMIN');
    const woman = await createMember({ profile: { displayName: 'Priya', gender: 'WOMAN' } });
    const man = await createMember({ profile: { displayName: 'Rahul', gender: 'MAN' } });

    const men = await request(app).get('/api/v1/admin/users?gender=MAN').set(bearer(admin.token));
    expect(men.status).toBe(200);
    expect(men.body.data.items.map((user) => user.id)).toEqual([man.id]);
    expect(men.body.data.items[0].gender).toBe('MAN');

    const women = await request(app).get('/api/v1/admin/users?gender=WOMAN').set(bearer(admin.token));
    expect(women.body.data.items.map((user) => user.id)).toEqual([woman.id]);
    expect(women.body.data.items[0].gender).toBe('WOMAN');
  });

  it('lists profile visibility and pending photos on the users list', async () => {
    const admin = await createStaff('ADMIN');
    const hidden = await createMember({ profile: { displayName: 'HiddenOne', visibilityStatus: 'HIDDEN' } });
    const pending = await createMember({ profile: { displayName: 'PendingPix' } });
    await Profile.updateOne(
      { userId: pending.id },
      {
        $push: {
          photos: {
            mediaId: 'med_aaaaaaaaaaaaaaaaaaaaaaaa',
            relativePath: '/uploads/profile/pending.jpg',
            order: 0,
            moderationStatus: 'PENDING',
          },
        },
      },
    );

    const byVisibility = await request(app).get('/api/v1/admin/users?visibility=HIDDEN').set(bearer(admin.token));
    expect(byVisibility.status).toBe(200);
    expect(byVisibility.body.data.items.map((user) => user.id)).toEqual([hidden.id]);
    expect(byVisibility.body.data.items[0].visibilityStatus).toBe('HIDDEN');

    const byPending = await request(app).get('/api/v1/admin/users?photoModeration=PENDING').set(bearer(admin.token));
    expect(byPending.body.data.items.map((user) => user.id)).toEqual([pending.id]);
    expect(byPending.body.data.items[0].pendingPhotoCount).toBe(1);
  });

  it('treats search text literally (no regex injection)', async () => {
    const admin = await createStaff('ADMIN');
    await createMember({ profile: { displayName: 'Priya' } });
    const res = await request(app).get('/api/v1/admin/users?q=.*').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('shows full contact details to admins and masked ones to moderators', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const member = await createMember();

    const forAdmin = await request(app).get(`/api/v1/admin/users/${member.id}`).set(bearer(admin.token));
    expect(forAdmin.body.data.phoneNumber).toBe(member.user.phoneNumber);

    const forModerator = await request(app).get(`/api/v1/admin/users/${member.id}`).set(bearer(moderator.token));
    expect(forModerator.body.data.phoneNumber).toMatch(/^\+91\*+\d{4}$/);
    expect(forModerator.body.data.phoneNumber).not.toBe(member.user.phoneNumber);
  });

  it('returns profile, entitlement and counts without secrets', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'Priya', bio: 'Hi' } });
    const res = await request(app).get(`/api/v1/admin/users/${member.id}`).set(bearer(admin.token));

    expect(res.body.data).toMatchObject({
      id: member.id,
      displayName: 'Priya',
      role: 'USER',
      status: 'ACTIVE',
      profile: { displayName: 'Priya', bio: 'Hi', gender: 'WOMAN', age: 28 },
      entitlement: { tier: 'FREE', isActive: false },
      stats: { reportsAgainst: 0, openReportsAgainst: 0, reportsMade: 0, activeMatches: 0 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|location|dateOfBirth/);
    expect((await request(app).get('/api/v1/admin/users/usr_000000000000000000000000').set(bearer(admin.token))).status).toBe(404);
  });

  it("lists a member's reports and matches", async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    const partner = await createMember({ profile: { displayName: 'Partner' } });
    const match = await matchMembers(app, member, partner);
    await Report.create({ reporterId: partner.id, targetType: 'USER', targetId: member.id, targetUserId: member.id, reason: 'SPAM_OR_SCAM' });

    const against = await request(app).get(`/api/v1/admin/users/${member.id}/reports`).set(bearer(admin.token));
    expect(against.body.data.items).toHaveLength(1);
    expect(against.body.data.items[0].reporter.id).toBe(partner.id);
    const by = await request(app).get(`/api/v1/admin/users/${member.id}/reports?direction=by`).set(bearer(admin.token));
    expect(by.body.data.items).toEqual([]);

    const matches = await request(app).get(`/api/v1/admin/users/${member.id}/matches`).set(bearer(admin.token));
    expect(matches.body.data.items).toEqual([
      expect.objectContaining({ id: match.id, status: 'ACTIVE', otherUser: expect.objectContaining({ id: partner.id, displayName: 'Partner' }), messageCount: 0 }),
    ]);
  });

  it('returns user management stats and sorted lists', async () => {
    const admin = await createStaff('ADMIN');
    await createMember({ user: { status: 'SUSPENDED', lastActiveAt: new Date() } });
    await createMember({ user: { status: 'BANNED' } });
    await createMember({ user: { lastActiveAt: new Date(Date.now() - 60 * 86400000) } });

    const stats = await request(app).get('/api/v1/admin/users/stats').set(bearer(admin.token));
    expect(stats.status).toBe(200);
    expect(stats.body.data).toMatchObject({
      total: expect.any(Number),
      active: expect.any(Number),
      inactive: expect.any(Number),
      online: expect.any(Number),
      suspended: expect.any(Number),
      banned: expect.any(Number),
    });
    expect(stats.body.data.total).toBeGreaterThanOrEqual(3);
    expect(stats.body.data.suspended).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.banned).toBeGreaterThanOrEqual(1);

    const sorted = await request(app).get('/api/v1/admin/users?sortBy=lastActiveAt&sortDir=desc').set(bearer(admin.token));
    expect(sorted.status).toBe(200);
    expect(sorted.body.data.items.length).toBeGreaterThan(0);
  });

  it('returns sessions, activity timeline, export and schedules deletion for admins', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const member = await createMember({ profile: { displayName: 'Export Me' } });
    await RefreshToken.create({ tokenHash: 'login-hash', userId: member.id, familyId: 'fam1', expiresAt: new Date(Date.now() + 86400000) });

    const sessions = await request(app).get(`/api/v1/admin/users/${member.id}/sessions`).set(bearer(admin.token));
    expect(sessions.status).toBe(200);
    expect(sessions.body.data.items[0]).toMatchObject({ familyId: 'fam1', status: 'ACTIVE' });

    const activity = await request(app).get(`/api/v1/admin/users/${member.id}/activity`).set(bearer(admin.token));
    expect(activity.status).toBe(200);
    expect(activity.body.data.items.some((event) => event.type === 'REGISTRATION')).toBe(true);
    expect(activity.body.data.items.some((event) => event.type === 'LOGIN')).toBe(true);

    expect((await request(app).get(`/api/v1/admin/users/${member.id}/export`).set(bearer(moderator.token))).status).toBe(403);
    const exported = await request(app).get(`/api/v1/admin/users/${member.id}/export`).set(bearer(admin.token));
    expect(exported.status).toBe(200);
    expect(exported.body.data.account.id).toBe(member.id);
    expect(exported.body.data.profile.displayName).toBe('Export Me');
    expect(await AuditLog.exists({ action: 'USER_DATA_EXPORTED', targetId: member.id })).toBeTruthy();

    expect((await request(app).post(`/api/v1/admin/users/${member.id}/deletion`).set(bearer(moderator.token)).send({ reason: 'Test delete' })).status).toBe(403);
    const deletion = await request(app).post(`/api/v1/admin/users/${member.id}/deletion`).set(bearer(admin.token)).send({ reason: 'Abuse confirmed' });
    expect(deletion.status).toBe(202);
    expect(deletion.body.data.status).toBe('SCHEDULED');
    expect(await AuditLog.exists({ action: 'USER_DELETION_SCHEDULED', targetId: member.id })).toBeTruthy();
  });
});

describe('admin users: status changes', () => {
  useTestDatabase();

  it('suspends a member: signs them out, ends matches and writes an audit entry', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await createMember();
    const partner = await createMember();
    const match = await matchMembers(app, member, partner);
    await RefreshToken.create({ tokenHash: 'h1', userId: member.id, familyId: 'f1', expiresAt: new Date(Date.now() + 86400000) });
    const until = new Date(Date.now() + 7 * 86400000).toISOString();

    const res = await changeStatus(moderator, member.id, { status: 'SUSPENDED', reason: 'Spamming members', until });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'SUSPENDED', statusReason: 'Spamming members', suspendedUntil: until });

    expect((await RefreshToken.findOne({ userId: member.id })).revokedReason).toBe('ACCOUNT_STATUS');
    expect(await Match.findById(match.id)).toMatchObject({ status: 'ENDED', endedReason: 'MODERATION' });
    expect((await request(app).get('/api/v1/profile/me').set(bearer(member.token))).body.error.code).toBe('ACCOUNT_INELIGIBLE');

    const audit = await AuditLog.findOne({ action: 'USER_STATUS_CHANGED' });
    expect(audit).toMatchObject({ actorId: moderator.id, actorRole: 'MODERATOR', targetType: 'USER', targetId: member.id });
    expect(audit.metadata).toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED', reason: 'Spamming members' });
  });

  it('warns a member with a SYSTEM notification', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await createMember();
    await changeStatus(moderator, member.id, { status: 'WARNED', reason: 'Rude messages' });
    expect(await Notification.exists({ userId: member.id, type: 'SYSTEM' })).toBeTruthy();
  });

  it('only admins can ban or unban', async () => {
    const moderator = await createStaff('MODERATOR');
    const admin = await createStaff('ADMIN');
    const member = await createMember();

    expect((await changeStatus(moderator, member.id, { status: 'BANNED', reason: 'Scammer' })).status).toBe(403);
    expect((await changeStatus(admin, member.id, { status: 'BANNED', reason: 'Scammer' })).status).toBe(200);
    expect((await changeStatus(moderator, member.id, { status: 'ACTIVE', reason: 'Appeal accepted' })).status).toBe(403);
    expect((await changeStatus(admin, member.id, { status: 'ACTIVE', reason: 'Appeal accepted' })).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'USER_STATUS_CHANGED' })).toBe(2);
  });

  it('protects staff accounts and blocks self-changes', async () => {
    const moderator = await createStaff('MODERATOR');
    const otherModerator = await createStaff('MODERATOR');
    const admin = await createStaff('ADMIN');

    expect((await changeStatus(moderator, otherModerator.id, { status: 'SUSPENDED', reason: 'Testing' })).status).toBe(403);
    expect((await changeStatus(admin, admin.id, { status: 'SUSPENDED', reason: 'Testing' })).status).toBe(403);
    expect((await changeStatus(admin, otherModerator.id, { status: 'WARNED', reason: 'Late reviews' })).status).toBe(200);
  });

  it('validates the change', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    const past = new Date(Date.now() - 1000).toISOString();

    const missing = await changeStatus(admin, member.id, { status: 'FROZEN' });
    expect(missing.body.error.details).toEqual([
      { field: 'status', reason: 'UNKNOWN_OPTION' },
      { field: 'reason', reason: 'REQUIRED' },
    ]);
    expect((await changeStatus(admin, member.id, { status: 'SUSPENDED', reason: 'Spam', until: past })).body.error.details).toEqual([{ field: 'until', reason: 'MUST_BE_FUTURE' }]);
    expect((await changeStatus(admin, member.id, { status: 'WARNED', reason: 'Spam', until: new Date(Date.now() + 1e6).toISOString() })).body.error.details).toEqual([
      { field: 'until', reason: 'ONLY_FOR_SUSPENDED' },
    ]);
    expect((await User.findById(member.id)).status).toBe('ACTIVE');
  });
});
