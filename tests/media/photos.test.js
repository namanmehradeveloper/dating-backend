// Tests profile photo management (add, reorder, delete) and selfie verification requests.

import fs from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Media } from '../../src/models/Media.js';
import { User } from '../../src/models/User.js';
import { VerificationRequest } from '../../src/models/VerificationRequest.js';
import { getAbsoluteFilePath } from '../../src/services/media.service.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { makeImage } from '../helpers/images.js';

const app = createApp();

// Uploads a JPEG and returns its mediaId.
async function uploadPhoto(token, purpose = 'PROFILE_PHOTO') {
  const res = await request(app)
    .post('/api/v1/media/upload')
    .set(bearer(token))
    .field('purpose', purpose)
    .attach('file', await makeImage('jpeg'), 'photo.jpg');
  return res.body.data.mediaId;
}

// Adds an uploaded photo to the profile.
function addPhoto(token, mediaId) {
  return request(app).post('/api/v1/profile/photos').set(bearer(token)).send({ mediaId });
}

describe('profile photos', () => {
  useTestDatabase();

  it('adds photos up to six, then answers CONFLICT', async () => {
    const member = await createMember();
    for (let index = 0; index < 6; index += 1) {
      const res = await addPhoto(member.token, await uploadPhoto(member.token));
      expect(res.status).toBe(201);
      expect(res.body.data.photos).toHaveLength(index + 1);
    }
    expect((await addPhoto(member.token, await uploadPhoto(member.token))).status).toBe(409);
  });

  it('rejects another member\'s media and rejected media', async () => {
    const member = await createMember();
    const other = await createMember();
    const othersMedia = await uploadPhoto(other.token);
    const notMine = await addPhoto(member.token, othersMedia);
    expect(notMine.body.error.details).toEqual([{ field: 'mediaId', reason: 'UNKNOWN_MEDIA' }]);

    const mine = await uploadPhoto(member.token);
    await Media.updateOne({ _id: mine }, { $set: { status: 'REJECTED' } });
    const rejected = await addPhoto(member.token, mine);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('MEDIA_REJECTED');
  });

  it('reorders photos', async () => {
    const member = await createMember();
    await addPhoto(member.token, await uploadPhoto(member.token));
    const profile = (await addPhoto(member.token, await uploadPhoto(member.token))).body.data;
    const [first, second] = profile.photos.map((photo) => photo.id);

    const res = await request(app).patch('/api/v1/profile/photos/order').set(bearer(member.token)).send({ photoIds: [second, first] });
    expect(res.status).toBe(200);
    expect(res.body.data.photos.map((photo) => photo.id)).toEqual([second, first]);

    const wrong = await request(app).patch('/api/v1/profile/photos/order').set(bearer(member.token)).send({ photoIds: [first] });
    expect(wrong.status).toBe(400);
  });

  it('deletes a photo and its file, keeping at least one', async () => {
    const member = await createMember();
    const firstMedia = await uploadPhoto(member.token);
    await addPhoto(member.token, firstMedia);
    const profile = (await addPhoto(member.token, await uploadPhoto(member.token))).body.data;
    const media = await Media.findById(firstMedia);

    const res = await request(app).delete(`/api/v1/profile/photos/${profile.photos[0].id}`).set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.photos).toHaveLength(1);
    expect(res.body.data.photos[0].order).toBe(0);
    expect(fs.existsSync(getAbsoluteFilePath(media.relativePath))).toBe(false);
    expect((await Media.findById(firstMedia)).status).toBe('DELETED');

    const last = await request(app).delete(`/api/v1/profile/photos/${res.body.data.photos[0].id}`).set(bearer(member.token));
    expect(last.status).toBe(409);
  });

  it('cannot delete another member\'s photo', async () => {
    const owner = await createMember();
    const attacker = await createMember();
    await addPhoto(owner.token, await uploadPhoto(owner.token));
    const profile = (await addPhoto(owner.token, await uploadPhoto(owner.token))).body.data;

    const res = await request(app).delete(`/api/v1/profile/photos/${profile.photos[0].id}`).set(bearer(attacker.token));
    expect(res.status).toBe(404);
    const ownerProfile = await request(app).get('/api/v1/profile/me').set(bearer(owner.token));
    expect(ownerProfile.body.data.photos).toHaveLength(2);
  });
});

describe('POST /profile/verification', () => {
  useTestDatabase();

  it('creates a pending request and sets the member to PENDING', async () => {
    const member = await createMember();
    const selfie = await uploadPhoto(member.token, 'VERIFICATION_SELFIE');
    const res = await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({ selfieMediaId: selfie });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'PENDING', submittedAt: expect.any(String) });
    expect((await User.findById(member.id)).verificationStatus).toBe('PENDING');
    expect(await VerificationRequest.countDocuments({ userId: member.id, status: 'PENDING' })).toBe(1);

    const again = await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({ selfieMediaId: selfie });
    expect(again.status).toBe(409);
  });

  it('requires a VERIFICATION_SELFIE upload', async () => {
    const member = await createMember();
    const photo = await uploadPhoto(member.token, 'PROFILE_PHOTO');
    const res = await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({ selfieMediaId: photo });
    expect(res.body.error.details).toEqual([{ field: 'selfieMediaId', reason: 'UNKNOWN_MEDIA' }]);
  });

  it('allows 3 submissions per day', async () => {
    const member = await createMember();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({});
    }
    const res = await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({});
    expect(res.status).toBe(429);
  });
});
