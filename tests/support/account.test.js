// Tests account deletion: scheduling, hiding the member, sign-in cancelling it, the purge job,
// and the data export status.

import fs from 'node:fs/promises';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { purgeDueAccounts } from '../../src/jobs/accountDeletion.job.js';
import { Match } from '../../src/models/Match.js';
import { Media } from '../../src/models/Media.js';
import { Profile } from '../../src/models/Profile.js';
import { RefreshToken } from '../../src/models/RefreshToken.js';
import { SubscriptionEntitlement } from '../../src/models/SubscriptionEntitlement.js';
import { Swipe } from '../../src/models/Swipe.js';
import { User } from '../../src/models/User.js';
import { getAbsoluteFilePath } from '../../src/services/media.service.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { makeImage } from '../helpers/images.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

// Schedules deletion for a member.
function requestDeletion(member, body = { confirm: true }) {
  return request(app).post('/api/v1/account/deletion-request').set(bearer(member.token)).send(body);
}

describe('account deletion', () => {
  useTestDatabase();

  it('requires confirm: true', async () => {
    const member = await createMember();
    const res = await requestDeletion(member, { confirm: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'confirm', reason: 'MUST_BE_TRUE' }]);
  });

  it('schedules deletion 14 days out, hides the member and revokes refresh tokens', async () => {
    const member = await createMember();
    const viewer = await createMember();
    await RefreshToken.create({ tokenHash: 'hash', userId: member.id, familyId: 'family', expiresAt: new Date(Date.now() + 86400000) });

    const res = await requestDeletion(member, { confirm: true, reason: 'Met someone', feedback: 'Thanks!' });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'SCHEDULED', scheduledFor: expect.any(String), activeStoreSubscription: false });
    const days = (new Date(res.body.data.scheduledFor) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    expect((await request(app).get(`/api/v1/profiles/${member.id}`).set(bearer(viewer.token))).status).toBe(404);
    expect((await RefreshToken.findOne({ userId: member.id })).revokedReason).toBe('ACCOUNT_DELETED');

    const again = await requestDeletion(member);
    expect(again.body.data.scheduledFor).toBe(res.body.data.scheduledFor);
  });

  it('flags an active store subscription that keeps renewing', async () => {
    const member = await createMember();
    await SubscriptionEntitlement.create({ userId: member.id, tier: 'PLUS', isActive: true, willRenew: true, platform: 'ANDROID', expiresAt: new Date(Date.now() + 86400000) });
    expect((await requestDeletion(member)).body.data.activeStoreSubscription).toBe(true);
  });

  it('is cancelled by signing in again', async () => {
    const member = await createMember();
    await requestDeletion(member);
    await request(app).post('/api/v1/auth/otp/request').send({ phoneNumber: member.user.phoneNumber });
    await request(app).post('/api/v1/auth/otp/verify').send({ phoneNumber: member.user.phoneNumber, code: env.fixedOtp });
    expect((await User.findById(member.id)).deletion.status).toBe('NONE');
  });

  it('erases the account, its files and its matches once the grace period ends', async () => {
    const member = await createMember();
    const partner = await createMember();
    const match = await matchMembers(app, member, partner);
    const upload = await request(app)
      .post('/api/v1/media/upload')
      .set(bearer(member.token))
      .field('purpose', 'PROFILE_PHOTO')
      .attach('file', await makeImage('jpeg'), 'photo.jpg');
    const media = await Media.findById(upload.body.data.id);

    await requestDeletion(member);
    expect(await purgeDueAccounts()).toBe(0);
    expect(await purgeDueAccounts(new Date(Date.now() + 15 * 86400000))).toBe(1);

    expect(await User.exists({ _id: member.id })).toBeNull();
    expect(await Profile.exists({ userId: member.id })).toBeNull();
    expect(await Swipe.exists({ $or: [{ userId: member.id }, { targetUserId: member.id }] })).toBeNull();
    expect(await Media.exists({ ownerId: member.id })).toBeNull();
    await expect(fs.access(getAbsoluteFilePath(media.relativePath))).rejects.toThrow();
    expect(await Match.findById(match.id)).toMatchObject({ status: 'ENDED', endedReason: 'ACCOUNT_DELETED' });
    expect(await User.exists({ _id: partner.id })).toBeTruthy();
  });
});

describe('GET /account/export-status', () => {
  useTestDatabase();

  it('reports that no export exists', async () => {
    const member = await createMember();
    const res = await request(app).get('/api/v1/account/export-status').set(bearer(member.token));
    expect(res.body.data).toEqual({ status: 'NONE' });
  });
});
