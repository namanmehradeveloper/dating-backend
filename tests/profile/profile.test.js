// Tests own-profile reads and edits, preferences, interests and public profile privacy.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { User } from '../../src/models/User.js';
import { issueAccessToken } from '../../src/services/token.service.js';
import { bearer, createMember, nextPhoneNumber, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('GET /profile/me', () => {
  useTestDatabase();

  it('returns the profile with private fields for the owner', async () => {
    const member = await createMember({ profile: { displayName: 'Alex', interestIds: ['int_hiking'], city: 'Pune' } });
    await request(app).get('/api/v1/interests').set(bearer(member.token));

    const res = await request(app).get('/api/v1/profile/me').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: member.id,
      displayName: 'Alex',
      age: 28,
      interests: ['Hiking'],
      city: 'Pune',
      phoneNumber: member.user.phoneNumber,
      gender: 'WOMAN',
      verificationStatus: 'NONE',
      isVerified: false,
      onboardingComplete: true,
      preferences: { minAge: 18, maxAge: 99, maxDistanceKm: 500, showMe: 'EVERYONE' },
    });
  });

  it('works before onboarding with empty fields', async () => {
    const user = await User.create({ phoneNumber: nextPhoneNumber() });
    const res = await request(app).get('/api/v1/profile/me').set(bearer(issueAccessToken(user)));
    expect(res.body.data).toMatchObject({ id: user._id, displayName: null, age: null, gender: null, onboardingComplete: false, photos: [] });
  });
});

describe('PATCH /profile/me', () => {
  useTestDatabase();

  it('updates the given fields and clears occupation', async () => {
    const member = await createMember({ profile: { occupation: 'Designer' } });
    const res = await request(app)
      .patch('/api/v1/profile/me')
      .set(bearer(member.token))
      .send({ bio: 'Weekend trail runner.', city: 'Mumbai', occupation: null, interests: ['Hiking', 'int_coffee'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ bio: 'Weekend trail runner.', city: 'Mumbai', occupation: null, interests: ['Hiking', 'Coffee'] });
  });

  it('validates displayName and requires at least one field', async () => {
    const member = await createMember();
    const tooLong = await request(app).patch('/api/v1/profile/me').set(bearer(member.token)).send({ displayName: 'x'.repeat(41) });
    expect(tooLong.body.error.details).toEqual([{ field: 'displayName', reason: 'LENGTH_1_40' }]);

    const empty = await request(app).patch('/api/v1/profile/me').set(bearer(member.token)).send({});
    expect(empty.status).toBe(400);
  });

  it('does not allow editing age or phone', async () => {
    const member = await createMember();
    const res = await request(app).patch('/api/v1/profile/me').set(bearer(member.token)).send({ bio: 'x', age: 20, phoneNumber: '+10000000000' });
    expect(res.body.data.age).toBe(28);
    expect(res.body.data.phoneNumber).toBe(member.user.phoneNumber);
  });

  it('allows 30 updates per hour', async () => {
    const member = await createMember();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(app).patch('/api/v1/profile/me').set(bearer(member.token)).send({ bio: `bio ${attempt}` });
    }
    const res = await request(app).patch('/api/v1/profile/me').set(bearer(member.token)).send({ bio: 'one more' });
    expect(res.status).toBe(429);
  });
});

describe('PUT /profile/preferences and /profile/interests', () => {
  useTestDatabase();

  it('replaces preferences', async () => {
    const member = await createMember();
    const preferences = { minAge: 24, maxAge: 36, maxDistanceKm: 25, showMe: 'EVERYONE' };
    const res = await request(app).put('/api/v1/profile/preferences').set(bearer(member.token)).send(preferences);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(preferences);
  });

  it.each([
    [{ minAge: 17, maxAge: 30, maxDistanceKm: 10, showMe: 'MEN' }, 'minAge'],
    [{ minAge: 40, maxAge: 30, maxDistanceKm: 10, showMe: 'MEN' }, 'minAge'],
    [{ minAge: 20, maxAge: 30, maxDistanceKm: 501, showMe: 'MEN' }, 'maxDistanceKm'],
    [{ minAge: 20, maxAge: 30, maxDistanceKm: 10, showMe: 'ANY' }, 'showMe'],
  ])('rejects invalid preferences %j', async (preferences, field) => {
    const member = await createMember();
    const res = await request(app).put('/api/v1/profile/preferences').set(bearer(member.token)).send(preferences);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((detail) => detail.field)).toContain(field);
  });

  it('replaces interests with known ids only', async () => {
    const member = await createMember();
    const ok = await request(app).put('/api/v1/profile/interests').set(bearer(member.token)).send({ interestIds: ['int_yoga'] });
    expect(ok.body.data.interests).toEqual(['Yoga']);

    const unknown = await request(app).put('/api/v1/profile/interests').set(bearer(member.token)).send({ interestIds: ['Yoga'] });
    expect(unknown.body.error.details).toEqual([{ field: 'interestIds', reason: 'UNKNOWN_INTEREST' }]);
  });
});

describe('GET /profiles/:userId', () => {
  useTestDatabase();

  it('returns a public profile without private data', async () => {
    const viewer = await createMember({ profile: { location: { type: 'Point', coordinates: [73.86, 18.52] } } });
    const target = await createMember({
      user: { verificationStatus: 'VERIFIED' },
      profile: { displayName: 'Avery', location: { type: 'Point', coordinates: [73.9, 18.55] } },
    });

    const res = await request(app).get(`/api/v1/profiles/${target.id}`).set(bearer(viewer.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: target.id, displayName: 'Avery', age: 28, isVerified: true });
    expect(res.body.data.distanceKm).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(res.body.data);
    for (const privateField of ['phoneNumber', 'dateOfBirth', 'preferences', 'location', 'coordinates', 'gender', 'verificationStatus', 'status']) {
      expect(serialized).not.toContain(`"${privateField}"`);
    }
    expect(serialized).not.toContain(target.user.phoneNumber);
  });

  it.each([
    ['blocked by the viewer', 'viewerBlocks'],
    ['blocking the viewer', 'targetBlocks'],
    ['banned', 'banned'],
    ['suspended', 'suspended'],
    ['pending deletion', 'deleting'],
  ])('returns 404 when the member is %s', async (_label, scenario) => {
    const viewer = await createMember();
    const target = await createMember();

    if (scenario === 'viewerBlocks') await Block.create({ blockerId: viewer.id, blockedId: target.id });
    if (scenario === 'targetBlocks') await Block.create({ blockerId: target.id, blockedId: viewer.id });
    if (scenario === 'banned') await User.updateOne({ _id: target.id }, { $set: { status: 'BANNED' } });
    if (scenario === 'suspended') await User.updateOne({ _id: target.id }, { $set: { status: 'SUSPENDED' } });
    if (scenario === 'deleting') await User.updateOne({ _id: target.id }, { $set: { 'deletion.status': 'SCHEDULED' } });

    const res = await request(app).get(`/api/v1/profiles/${target.id}`).set(bearer(viewer.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for unknown ids', async () => {
    const viewer = await createMember();
    expect((await request(app).get('/api/v1/profiles/usr_000000000000000000000000').set(bearer(viewer.token))).status).toBe(404);
  });
});
