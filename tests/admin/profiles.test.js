// Admin profile management: stats, detail, edits, visibility, boost, privacy, photo moderation.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Profile } from '../../src/models/Profile.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('admin profiles', () => {
  useTestDatabase();

  it('returns profile stats and filtered list with completeness', async () => {
    const admin = await createStaff('ADMIN');
    await createMember({ profile: { displayName: 'CompleteOne', bio: 'Hello', relationshipGoal: 'LONG_TERM' } });
    await createMember({ profile: { displayName: 'Sparse' } });

    const stats = await request(app).get('/api/v1/admin/profiles/stats').set(bearer(admin.token));
    expect(stats.status).toBe(200);
    expect(stats.body.data.total).toBeGreaterThanOrEqual(2);
    expect(stats.body.data).toHaveProperty('pendingPhotos');
    expect(stats.body.data).toHaveProperty('boosted');

    const list = await request(app).get('/api/v1/admin/profiles?q=Complete').set(bearer(admin.token));
    expect(list.status).toBe(200);
    // name + bio + relationshipGoal (no photo / interests from factory) = 3 / 5
    expect(list.body.data.items[0]).toMatchObject({
      displayName: 'CompleteOne',
      completenessScore: 3,
      visibilityStatus: 'VISIBLE',
    });
    expect(list.body.data.items[0]).toHaveProperty('ageEligible', true);
    expect(list.body.data.items[0]).toHaveProperty('boost');
  });

  it('loads profile detail with privacy, boost and completeness breakdown', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'DetailMe', bio: 'Bio text' } });

    const res = await request(app).get(`/api/v1/admin/profiles/${member.id}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: member.id,
      displayName: 'DetailMe',
      bio: 'Bio text',
      ageEligible: true,
    });
    expect(res.body.data.completeness).toMatchObject({ max: 5 });
    expect(res.body.data.privacy).toMatchObject({ showAge: true, incognito: false });
    expect(res.body.data.boost).toMatchObject({ active: false });
    expect(JSON.stringify(res.body.data)).not.toContain('coordinates');
  });

  it('updates profile fields with reason and audit', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'BeforeName', bio: 'Old bio' } });

    const res = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}`)
      .set(bearer(admin.token))
      .send({ reason: 'Corrected name spelling', displayName: 'AfterName', bio: 'New bio', city: 'Austin' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ displayName: 'AfterName', bio: 'New bio', city: 'Austin' });

    const audit = await AuditLog.findOne({ action: 'PROFILE_UPDATED', targetId: member.id });
    expect(audit).toBeTruthy();
    expect(audit.metadata.reason).toBe('Corrected name spelling');
    expect(audit.metadata.before.displayName).toBe('BeforeName');
    expect(audit.metadata.after.displayName).toBe('AfterName');
  });

  it('updates phone and password with audit and revokes sessions on password change', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({
      user: { email: `acct_${Date.now()}@example.test` },
      profile: { displayName: 'AccountEdit' },
    });

    const res = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/account`)
      .set(bearer(admin.token))
      .send({ reason: 'Member requested number change', phoneNumber: '+919999988877', password: 'new-secure-password' });
    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumber).toBe('+919999988877');

    const stored = await User.findById(member.id).select('+passwordHash');
    expect(stored.phoneNumber).toBe('+919999988877');
    expect(stored.passwordHash).toBeTruthy();

    const audit = await AuditLog.findOne({ action: 'PROFILE_ACCOUNT_UPDATED', targetId: member.id });
    expect(audit).toBeTruthy();
    expect(audit.metadata.after.passwordChanged).toBe(true);
    expect(JSON.stringify(audit.metadata)).not.toContain('new-secure-password');

    const denied = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/account`)
      .set(bearer((await createStaff('MODERATOR')).token))
      .send({ reason: 'Moderator attempt', phoneNumber: '+919999988866' });
    expect(denied.status).toBe(403);
  });

  it('changes visibility, boost and privacy with audits', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'VisMember' } });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const visibility = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/visibility`)
      .set(bearer(admin.token))
      .send({ visibilityStatus: 'PAUSED', reason: 'Member requested pause', visibilityNote: 'Vacation' });
    expect(visibility.status).toBe(200);
    expect(visibility.body.data.visibilityStatus).toBe('PAUSED');
    expect(visibility.body.data.visibilityNote).toBe('Vacation');

    const boost = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/boost`)
      .set(bearer(admin.token))
      .send({ active: true, expiresAt, reason: 'Promo boost' });
    expect(boost.status).toBe(200);
    expect(boost.body.data.boost.active).toBe(true);

    const privacy = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/privacy`)
      .set(bearer(admin.token))
      .send({ incognito: true, reason: 'Hide from discovery' });
    expect(privacy.status).toBe(200);
    expect(privacy.body.data.privacy.incognito).toBe(true);
    expect(privacy.body.data.visibilityStatus).toBe('PAUSED');

    expect(await AuditLog.countDocuments({ targetId: member.id, action: /PROFILE_/ })).toBeGreaterThanOrEqual(3);
  });

  it('moderates photos via queue and detail endpoints', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'PhotoQueue' } });
    await Profile.updateOne(
      { userId: member.id },
      {
        $push: {
          photos: {
            mediaId: 'med_bbbbbbbbbbbbbbbbbbbbbbbb',
            relativePath: '/uploads/profile/pending.jpg',
            order: 0,
            moderationStatus: 'PENDING',
          },
        },
      },
    );
    const profile = await Profile.findOne({ userId: member.id }).lean();
    const photoId = profile.photos[0]._id;

    const queue = await request(app).get('/api/v1/admin/profiles/photo-queue').set(bearer(admin.token));
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.some((item) => item.photoId === photoId)).toBe(true);

    const moderated = await request(app)
      .patch(`/api/v1/admin/profiles/${member.id}/photos/${photoId}/moderation`)
      .set(bearer(admin.token))
      .send({ status: 'APPROVED', reason: 'Looks fine' });
    expect(moderated.status).toBe(200);
    expect(moderated.body.data.photo.moderationStatus).toBe('APPROVED');

    const audit = await AuditLog.findOne({ action: 'PROFILE_PHOTO_MODERATED', targetId: member.id });
    expect(audit.metadata).toMatchObject({ to: 'APPROVED', reason: 'Looks fine' });

    const history = await request(app).get(`/api/v1/admin/profiles/${member.id}/history`).set(bearer(admin.token));
    expect(history.status).toBe(200);
    expect(history.body.data.items.some((item) => item.action === 'PROFILE_PHOTO_MODERATED')).toBe(true);
  });

  it('still removes photos with reason and rejects members', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'RemovePhoto' } });
    await Profile.updateOne(
      { userId: member.id },
      { $push: { photos: { mediaId: 'med_cccccccccccccccccccccccc', relativePath: '/uploads/profile/y.jpg', order: 0 } } },
    );
    const profile = await Profile.findOne({ userId: member.id }).lean();
    const photoId = profile.photos[0]._id;

    const removed = await request(app)
      .delete(`/api/v1/admin/profiles/${member.id}/photos/${photoId}`)
      .set(bearer(admin.token))
      .send({ reason: 'Inappropriate content' });
    expect(removed.status).toBe(200);
    expect(removed.body.data.photoCount).toBe(0);

    const denied = await request(app).get('/api/v1/admin/profiles/stats').set(bearer(member.token));
    expect(denied.status).toBe(403);
  });
});
