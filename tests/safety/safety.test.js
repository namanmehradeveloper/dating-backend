// Tests blocking (and its side effects), the block list, member/photo reports and message reports.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { Profile } from '../../src/models/Profile.js';
import { Report } from '../../src/models/Report.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

// Sends a chat message.
function sendMessage(member, conversationId, text = 'Hello') {
  const clientMessageId = uuidv4();
  return request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(bearer(member.token))
    .set('Idempotency-Key', clientMessageId)
    .send({ text, clientMessageId });
}

describe('blocking', () => {
  useTestDatabase();

  it('ends the match, closes the conversation and hides the profile both ways', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);

    const res = await request(app).post(`/api/v1/users/${avery.id}/block`).set(bearer(alex.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();

    expect((await Match.findById(match.id)).status).toBe('ENDED');
    expect((await Match.findById(match.id)).endedReason).toBe('BLOCK');
    expect((await Conversation.findById(match.conversationId)).status).toBe('CLOSED');
    expect((await request(app).get(`/api/v1/profiles/${avery.id}`).set(bearer(alex.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/profiles/${alex.id}`).set(bearer(avery.token))).status).toBe(404);
    expect((await sendMessage(avery, match.conversationId)).status).toBe(403);
  });

  it('is idempotent and lists blocks', async () => {
    const alex = await createMember();
    const avery = await createMember({ profile: { displayName: 'Avery' } });
    await request(app).post(`/api/v1/users/${avery.id}/block`).set(bearer(alex.token));
    await request(app).post(`/api/v1/users/${avery.id}/block`).set(bearer(alex.token));
    expect(await Block.countDocuments()).toBe(1);

    const res = await request(app).get('/api/v1/blocks').set(bearer(alex.token));
    expect(res.body.data).toEqual({ items: [{ user: { id: avery.id, displayName: 'Avery' }, blockedAt: expect.any(String) }], nextCursor: null });
    expect((await request(app).get('/api/v1/blocks').set(bearer(avery.token))).body.data.items).toEqual([]);
  });

  it('unblocking does not restore the match', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    await request(app).post(`/api/v1/users/${avery.id}/block`).set(bearer(alex.token));

    const res = await request(app).delete(`/api/v1/users/${avery.id}/block`).set(bearer(alex.token));
    expect(res.status).toBe(200);
    expect(await Block.countDocuments()).toBe(0);
    expect((await Match.findById(match.id)).status).toBe('ENDED');
    expect((await request(app).get(`/api/v1/profiles/${avery.id}`).set(bearer(alex.token))).status).toBe(200);
  });

  it('rejects blocking yourself or an unknown member', async () => {
    const alex = await createMember();
    expect((await request(app).post(`/api/v1/users/${alex.id}/block`).set(bearer(alex.token))).status).toBe(400);
    expect((await request(app).post('/api/v1/users/usr_000000000000000000000000/block').set(bearer(alex.token))).status).toBe(404);
  });
});

describe('POST /reports', () => {
  useTestDatabase();

  it('reports a member and blocks them by default', async () => {
    const reporter = await createMember();
    const target = await createMember();
    const res = await request(app)
      .post('/api/v1/reports')
      .set(bearer(reporter.token))
      .send({ targetType: 'USER', targetId: target.id, reason: 'FAKE_PROFILE', details: 'Stock photos' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: expect.stringMatching(/^rep_/), status: 'OPEN', createdAt: expect.any(String) });
    expect(await Block.exists({ blockerId: reporter.id, blockedId: target.id })).toBeTruthy();
  });

  it('reports a photo without blocking when alsoBlock is false', async () => {
    const reporter = await createMember();
    const target = await createMember();
    await Profile.updateOne({ userId: target.id }, { $push: { photos: { mediaId: 'med_x', relativePath: '/uploads/profile/x.jpg', order: 0 } } });
    const photoId = (await Profile.findOne({ userId: target.id })).photos[0]._id;

    const res = await request(app)
      .post('/api/v1/reports')
      .set(bearer(reporter.token))
      .send({ targetType: 'PHOTO', targetId: photoId, reason: 'INAPPROPRIATE_PHOTOS', alsoBlock: false });

    expect(res.status).toBe(201);
    expect((await Report.findById(res.body.data.id)).targetUserId).toBe(target.id);
    expect(await Block.countDocuments()).toBe(0);
  });

  it('validates the report', async () => {
    const reporter = await createMember();
    const res = await request(app).post('/api/v1/reports').set(bearer(reporter.token)).send({ targetType: 'GROUP', reason: 'RUDE' });
    expect(res.body.error.details.map((detail) => detail.field).sort()).toEqual(['reason', 'targetId', 'targetType']);

    const self = await request(app).post('/api/v1/reports').set(bearer(reporter.token)).send({ targetType: 'USER', targetId: reporter.id, reason: 'OTHER' });
    expect(self.status).toBe(400);
  });

  it('allows 20 reports per day', async () => {
    const reporter = await createMember();
    const target = await createMember();
    const body = { targetType: 'USER', targetId: target.id, reason: 'SPAM_OR_SCAM', alsoBlock: false };
    for (let index = 0; index < 20; index += 1) {
      expect((await request(app).post('/api/v1/reports').set(bearer(reporter.token)).send(body)).status).toBe(201);
    }
    expect((await request(app).post('/api/v1/reports').set(bearer(reporter.token)).send(body)).status).toBe(429);
  });
});

describe('POST /messages/:messageId/report', () => {
  useTestDatabase();

  it('reports a received message and blocks the sender', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const message = (await sendMessage(avery, match.conversationId, 'rude words')).body.data;

    const res = await request(app).post(`/api/v1/messages/${message.id}/report`).set(bearer(alex.token)).send({ reason: 'HARASSMENT' });
    expect(res.status).toBe(201);
    const report = await Report.findById(res.body.data.id);
    expect(report).toMatchObject({ targetType: 'MESSAGE', targetId: message.id, targetUserId: avery.id });
    expect((await Conversation.findById(match.conversationId)).status).toBe('CLOSED');
  });

  it('cannot report your own message or one from another conversation', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, alex, avery);
    const message = (await sendMessage(alex, match.conversationId)).body.data;

    expect((await request(app).post(`/api/v1/messages/${message.id}/report`).set(bearer(alex.token)).send({ reason: 'OTHER' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/messages/${message.id}/report`).set(bearer(outsider.token)).send({ reason: 'OTHER' })).status).toBe(404);
  });
});
