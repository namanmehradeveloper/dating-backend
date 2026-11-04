// Tests POST /media/upload (local storage with Multer + Sharp), GET /media/:mediaId and /uploads serving.

import fs from 'node:fs';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Media } from '../../src/models/Media.js';
import { Message } from '../../src/models/Message.js';
import { Profile } from '../../src/models/Profile.js';
import { getAbsoluteFilePath } from '../../src/services/media.service.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { makeImage } from '../helpers/images.js';

const app = createApp();

// Uploads a buffer as multipart/form-data.
function upload(token, buffer, { purpose = 'PROFILE_PHOTO', filename = 'photo.jpg', contentType = 'image/jpeg' } = {}) {
  return request(app)
    .post('/api/v1/media/upload')
    .set(bearer(token))
    .field('purpose', purpose)
    .attach('file', buffer, { filename, contentType });
}

describe('POST /media/upload', () => {
  useTestDatabase();

  it.each([
    ['jpeg', 'image/jpeg', 'jpg'],
    ['png', 'image/png', 'png'],
    ['webp', 'image/webp', 'webp'],
  ])('stores a %s image locally and returns its mediaId and URL', async (format, contentType, extension) => {
    const member = await createMember();
    const res = await upload(member.token, await makeImage(format), { filename: `x.${extension}`, contentType });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: expect.stringMatching(/^med_/),
      purpose: 'PROFILE_PHOTO',
      status: 'APPROVED',
      contentType,
      width: 64,
      height: 48,
    });
    expect(res.body.data.mediaId).toBe(res.body.data.id);
    expect(res.body.data.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:5050/uploads/profile/${member.id}_\\d+_[0-9a-f]{6}\\.${extension}$`));

    const media = await Media.findById(res.body.data.id);
    expect(media.relativePath).toMatch(new RegExp(`^/uploads/profile/${member.id}_\\d+_[0-9a-f]{6}\\.${extension}$`));
    expect(fs.existsSync(getAbsoluteFilePath(media.relativePath))).toBe(true);
  });

  it('ignores the original file name and stores a relative path only', async () => {
    const member = await createMember();
    const res = await upload(member.token, await makeImage('jpeg'), { filename: '../../evil name.jpg' });
    const media = await Media.findById(res.body.data.id).lean();

    expect(media.relativePath).not.toContain('evil');
    expect(media.relativePath).not.toMatch(/^[A-Za-z]:\\|^\/Users|^\/home/);
    expect(JSON.stringify(media)).not.toMatch(/base64|Binary/);
  });

  it('strips EXIF metadata such as GPS and camera details', async () => {
    const member = await createMember();
    const withExif = await makeImage('jpeg', { exif: { IFD0: { Artist: 'Secret Person', Copyright: 'Private' } } });
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const res = await upload(member.token, withExif);
    const media = await Media.findById(res.body.data.id);
    const saved = fs.readFileSync(getAbsoluteFilePath(media.relativePath));

    expect((await sharp(saved).metadata()).exif).toBeUndefined();
    expect(saved.toString('latin1')).not.toContain('Secret Person');
  });

  it('stores verification selfies in the verification folder with a signed URL', async () => {
    const member = await createMember();
    const res = await upload(member.token, await makeImage('jpeg'), { purpose: 'VERIFICATION_SELFIE' });
    expect(res.body.data.url).toMatch(/\/uploads\/verification\/.+\?expires=\d+&signature=/);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/media/upload').field('purpose', 'PROFILE_PHOTO').attach('file', await makeImage('jpeg'), 'a.jpg');
    expect(res.status).toBe(401);
  });

  it('rejects files over 10 MB with MEDIA_REJECTED / TOO_LARGE', async () => {
    const member = await createMember();
    const res = await upload(member.token, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'MEDIA_REJECTED', details: [{ field: 'file', reason: 'TOO_LARGE' }] });
  });

  it('rejects a non-image disguised as a JPEG', async () => {
    const member = await createMember();
    const res = await upload(member.token, Buffer.from('this is not an image at all'), { filename: 'fake.jpg' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ field: 'file', reason: 'UNSUPPORTED_TYPE' }]);
  });

  it('rejects unsupported image formats such as GIF even with an image/jpeg type', async () => {
    const member = await createMember();
    const res = await upload(member.token, await makeImage('gif'), { filename: 'anim.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].reason).toBe('UNSUPPORTED_TYPE');
  });

  it('validates purpose and the file field', async () => {
    const member = await createMember();
    const badPurpose = await upload(member.token, await makeImage('jpeg'), { purpose: 'AVATAR' });
    expect(badPurpose.body.error.details).toEqual([{ field: 'purpose', reason: 'INVALID' }]);

    const noFile = await request(app).post('/api/v1/media/upload').set(bearer(member.token)).field('purpose', 'PROFILE_PHOTO');
    expect(noFile.body.error.details).toEqual([{ field: 'file', reason: 'REQUIRED' }]);
  });

  it('allows 30 uploads per hour', async () => {
    const member = await createMember();
    const tiny = Buffer.from('x');
    for (let attempt = 0; attempt < 30; attempt += 1) await upload(member.token, tiny);
    expect((await upload(member.token, tiny)).status).toBe(429);
  });
});

describe('GET /media/:mediaId and /uploads', () => {
  useTestDatabase();

  it('returns metadata to the owner and serves the public profile file', async () => {
    const member = await createMember();
    const uploaded = (await upload(member.token, await makeImage('png'), { contentType: 'image/png' })).body.data;

    const res = await request(app).get(`/api/v1/media/${uploaded.id}`).set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(uploaded.url);

    const file = await request(app).get(new URL(uploaded.url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('hides another member\'s unattached and verification media', async () => {
    const owner = await createMember();
    const viewer = await createMember();
    const photo = (await upload(owner.token, await makeImage('jpeg'))).body.data;
    const selfie = (await upload(owner.token, await makeImage('jpeg'), { purpose: 'VERIFICATION_SELFIE' })).body.data;

    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(viewer.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/media/${selfie.id}`).set(bearer(viewer.token))).status).toBe(404);
  });

  it('shows profile photos on a visible profile, but not across a block', async () => {
    const owner = await createMember();
    const viewer = await createMember();
    const photo = (await upload(owner.token, await makeImage('jpeg'))).body.data;
    await Profile.updateOne({ userId: owner.id }, { $push: { photos: { mediaId: photo.id, relativePath: '/uploads/profile/x.jpg', order: 0 } } });

    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(viewer.token))).status).toBe(200);
    await Block.create({ blockerId: owner.id, blockedId: viewer.id });
    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(viewer.token))).status).toBe(404);
  });

  it('shows chat attachments only to an active match they were sent to', async () => {
    const owner = await createMember();
    const match = await createMember();
    const stranger = await createMember();
    const file = (await upload(owner.token, await makeImage('jpeg'), { purpose: 'CHAT_ATTACHMENT' })).body.data;
    await Conversation.create({ _id: 'cnv_test', matchId: 'mat_test', participantIds: [owner.id, match.id] });
    expect((await request(app).get(`/api/v1/media/${file.id}`).set(bearer(match.token))).status).toBe(404);

    const media = await Media.findById(file.id).lean();
    await Message.create({
      conversationId: 'cnv_test',
      senderId: owner.id,
      attachment: { mediaId: media._id, relativePath: media.relativePath, contentType: media.contentType },
    });
    expect((await request(app).get(`/api/v1/media/${file.id}`).set(bearer(match.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/media/${file.id}`).set(bearer(stranger.token))).status).toBe(404);
  });

  it('serves private files only with a valid signature', async () => {
    const member = await createMember();
    const selfie = (await upload(member.token, await makeImage('jpeg'), { purpose: 'VERIFICATION_SELFIE' })).body.data;
    const signedUrl = new URL(selfie.url);

    expect((await request(app).get(signedUrl.pathname + signedUrl.search)).status).toBe(200);
    expect((await request(app).get(signedUrl.pathname)).status).toBe(404);
    expect((await request(app).get(`${signedUrl.pathname}?expires=9999999999&signature=forged`)).status).toBe(404);
  });

  it('never serves the temp folder or paths outside uploads', async () => {
    expect((await request(app).get('/uploads/temp/anything.jpg')).status).toBe(404);
    expect((await request(app).get('/uploads/../package.json')).status).toBe(404);
    expect((await request(app).get('/uploads/profile/..%2F..%2Fpackage.json')).status).toBe(404);
  });
});
