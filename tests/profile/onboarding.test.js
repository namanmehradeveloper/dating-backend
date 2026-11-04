// Tests GET /interests and POST /profile/onboarding: every documented rule, the server-side
// age check, photo ownership and the one-time nature of onboarding.

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Media } from '../../src/models/Media.js';
import { Profile } from '../../src/models/Profile.js';
import { User } from '../../src/models/User.js';
import { issueAccessToken } from '../../src/services/token.service.js';
import { bearer, nextPhoneNumber, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

// Creates a new member who has not onboarded yet, plus two uploaded profile photos.
async function createNewMember() {
  const user = await User.create({ phoneNumber: nextPhoneNumber() });
  const photos = await Media.create([0, 1].map((index) => ({
    ownerId: user._id,
    purpose: 'PROFILE_PHOTO',
    contentType: 'image/jpeg',
    sizeBytes: 1000,
    relativePath: `/uploads/profile/${user._id}_${index}.jpg`,
  })));
  return { user, token: issueAccessToken(user), photoIds: photos.map((photo) => photo._id) };
}

// A complete, valid onboarding body.
function validBody(photoIds) {
  return {
    displayName: 'Sam',
    dateOfBirth: '1998-02-14',
    gender: 'NON_BINARY',
    showGender: true,
    showMe: 'WOMEN',
    maxDistanceKm: 80,
    relationshipGoal: 'LONG_TERM',
    interestIds: ['int_hiking', 'int_coffee'],
    photoMediaIds: photoIds,
    basics: { drinking: 'SOBER', workout: 'OFTEN' },
    bio: 'Coffee first, then adventures.',
    prompt: { promptId: 'GREEN_FLAG', answer: 'Kindness to waiters.' },
    location: { latitude: 18.5204, longitude: 73.8567 },
    acceptedTermsVersion: '2026-01',
  };
}

describe('GET /interests', () => {
  useTestDatabase();

  it('returns the 24 seeded interests in 6 categories', async () => {
    const { token } = await createNewMember();
    const res = await request(app).get('/api/v1/interests').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(24);
    expect(res.body.data.items[0]).toEqual({ id: 'int_hiking', label: 'Hiking', category: 'Outdoors' });
    expect(new Set(res.body.data.items.map((item) => item.category)).size).toBe(6);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/interests')).status).toBe(401);
  });
});

describe('POST /profile/onboarding', () => {
  useTestDatabase();
  let member;

  beforeEach(async () => {
    member = await createNewMember();
  });

  // Sends an onboarding request for the current member.
  function onboard(body) {
    return request(app).post('/api/v1/profile/onboarding').set(bearer(member.token)).send(body);
  }

  it('creates the profile and completes onboarding', async () => {
    const res = await onboard(validBody(member.photoIds));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: member.user._id,
      displayName: 'Sam',
      gender: 'NON_BINARY',
      onboardingComplete: true,
      interests: ['Hiking', 'Coffee'],
      relationshipGoal: 'LONG_TERM',
      basics: { drinking: 'SOBER', workout: 'OFTEN' },
      prompt: { promptId: 'GREEN_FLAG', answer: 'Kindness to waiters.' },
      preferences: { minAge: 18, maxAge: 99, maxDistanceKm: 80, showMe: 'WOMEN' },
    });
    expect(res.body.data.photos.map((photo) => photo.order)).toEqual([0, 1]);
    expect(res.body.data.photos[0].url).toMatch(/^http:\/\/127\.0\.0\.1:5050\/uploads\/profile\//);

    const profile = await Profile.findOne({ userId: member.user._id });
    expect(profile.location.coordinates).toEqual([73.86, 18.52]);
    expect((await User.findById(member.user._id)).onboardingComplete).toBe(true);
  });

  it('rejects a second onboarding with CONFLICT', async () => {
    await onboard(validBody(member.photoIds));
    const res = await onboard(validBody(member.photoIds));
    expect(res.status).toBe(409);
  });

  it('rejects under-18 members with ACCOUNT_INELIGIBLE', async () => {
    const year = new Date().getUTCFullYear() - 17;
    const res = await onboard({ ...validBody(member.photoIds), dateOfBirth: `${year}-06-01` });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INELIGIBLE');
    expect((await User.findById(member.user._id)).onboardingComplete).toBe(false);
  });

  it.each([
    ['displayName', '', 'REQUIRED'],
    ['displayName', 'x'.repeat(41), 'LENGTH_1_40'],
    ['dateOfBirth', '14/02/1998', 'INVALID'],
    ['gender', 'OTHER', 'UNKNOWN_OPTION'],
    ['showMe', 'ALL', 'UNKNOWN_OPTION'],
    ['maxDistanceKm', 0, 'RANGE_1_500'],
    ['maxDistanceKm', 501, 'RANGE_1_500'],
    ['relationshipGoal', 'MARRIAGE', 'UNKNOWN_OPTION'],
    ['interestIds', [], 'COUNT_1_10'],
    ['interestIds', ['int_hiking', 'int_hiking'], 'COUNT_1_10'],
    ['photoMediaIds', ['med_1'], 'COUNT_2_6'],
    ['bio', 'x'.repeat(501), 'MAX_500'],
    ['basics', { drinking: 'not valid' }, 'UNKNOWN_OPTION'],
    ['location', { latitude: 200, longitude: 0 }, 'INVALID'],
  ])('rejects %s=%j with %s', async (field, value, reason) => {
    const res = await onboard({ ...validBody(member.photoIds), [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toContainEqual({ field, reason });
  });

  it('rejects an old Terms version', async () => {
    const res = await onboard({ ...validBody(member.photoIds), acceptedTermsVersion: '2025-01' });
    expect(res.body.error.details).toContainEqual({ field: 'acceptedTermsVersion', reason: 'NOT_CURRENT' });
  });

  it('rejects unknown interests', async () => {
    const res = await onboard({ ...validBody(member.photoIds), interestIds: ['int_hiking', 'int_unknown'] });
    expect(res.body.error.details).toContainEqual({ field: 'interestIds', reason: 'UNKNOWN_INTEREST' });
  });

  it('rejects photos uploaded by another member', async () => {
    const other = await createNewMember();
    const res = await onboard(validBody(other.photoIds));
    expect(res.body.error.details).toContainEqual({ field: 'photoMediaIds', reason: 'UNKNOWN_MEDIA' });
  });

  it('rejects rejected photos', async () => {
    await Media.updateOne({ _id: member.photoIds[0] }, { $set: { status: 'REJECTED' } });
    const res = await onboard(validBody(member.photoIds));
    expect(res.body.error.details).toContainEqual({ field: 'photoMediaIds', reason: 'UNKNOWN_MEDIA' });
  });

  it('reports every invalid field at once', async () => {
    const res = await onboard({});
    const fields = res.body.error.details.map((detail) => detail.field);
    expect(fields).toEqual(expect.arrayContaining(['displayName', 'dateOfBirth', 'gender', 'showMe', 'maxDistanceKm', 'relationshipGoal', 'interestIds', 'photoMediaIds', 'acceptedTermsVersion']));
  });

  it('allows 10 onboarding attempts per hour', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) await onboard({});
    expect((await onboard({})).status).toBe(429);
  });
});
