// Tests POST /swipes (idempotency, matching, quotas, visibility) and POST /swipes/undo.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AppSetting } from '../../src/models/AppSetting.js';
import { Block } from '../../src/models/Block.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { Notification } from '../../src/models/Notification.js';
import { Swipe } from '../../src/models/Swipe.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';
import { swipe } from '../helpers/social.js';

const app = createApp();

// Inserts `count` recent swipes of one action for a member (to use up the free quota quickly).
async function insertRecentSwipes(userId, action, count) {
  const swipes = Array.from({ length: count }, (_, index) => ({ userId, targetUserId: `usr_fake_${index}`, action }));
  await Swipe.insertMany(swipes);
}

describe('POST /swipes', () => {
  useTestDatabase();

  it('requires an Idempotency-Key', async () => {
    const member = await createMember();
    const target = await createMember();
    const res = await request(app).post('/api/v1/swipes').set(bearer(member.token)).send({ targetUserId: target.id, action: 'LIKE' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'Idempotency-Key', reason: 'REQUIRED' }]);
  });

  it('records a pass without a match', async () => {
    const member = await createMember();
    const target = await createMember();
    const res = await swipe(app, member, target.id, 'PASS');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ swipeId: expect.stringMatching(/^swp_/), isMatch: false, match: null });
  });

  it('creates a match and conversation on a mutual like', async () => {
    const first = await createMember({ profile: { displayName: 'Alex' } });
    const second = await createMember({ profile: { displayName: 'Avery' } });

    expect((await swipe(app, first, second.id, 'LIKE')).body.data.isMatch).toBe(false);
    const res = await swipe(app, second, first.id, 'SUPER_LIKE');

    expect(res.body.data.isMatch).toBe(true);
    expect(res.body.data.match).toMatchObject({
      id: expect.stringMatching(/^mat_/),
      conversationId: expect.stringMatching(/^cnv_/),
      matchedAt: expect.any(String),
      otherUser: { id: first.id, displayName: 'Alex' },
    });
    expect(await Match.countDocuments()).toBe(1);
    expect(await Conversation.countDocuments({ _id: res.body.data.match.conversationId, status: 'ACTIVE' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'NEW_MATCH' })).toBe(2);
  });

  it('replays the original response for the same key and body', async () => {
    const member = await createMember();
    const target = await createMember();
    const key = uuidv4();
    const first = await swipe(app, member, target.id, 'LIKE', key);
    const replay = await swipe(app, member, target.id, 'LIKE', key);

    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(replay.body.meta.requestId).not.toBe(first.body.meta.requestId);
    expect(await Swipe.countDocuments({ userId: member.id })).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const member = await createMember();
    const target = await createMember();
    const key = uuidv4();
    await swipe(app, member, target.id, 'LIKE', key);
    const res = await swipe(app, member, target.id, 'PASS', key);
    expect(res.status).toBe(409);
  });

  it('rejects a second swipe on the same member with a new key', async () => {
    const member = await createMember();
    const target = await createMember();
    await swipe(app, member, target.id, 'LIKE');
    expect((await swipe(app, member, target.id, 'PASS')).status).toBe(409);
  });

  it('lets a failed request be retried with the same key', async () => {
    const member = await createMember();
    const target = await createMember({ user: { status: 'BANNED' } });
    const key = uuidv4();
    expect((await swipe(app, member, target.id, 'LIKE', key)).status).toBe(404);

    await target.user.updateOne({ $set: { status: 'ACTIVE' } });
    expect((await swipe(app, member, target.id, 'LIKE', key)).status).toBe(200);
  });

  it('rejects self, unknown and blocked targets', async () => {
    const member = await createMember();
    const blocked = await createMember();
    await Block.create({ blockerId: blocked.id, blockedId: member.id });

    expect((await swipe(app, member, member.id)).status).toBe(400);
    expect((await swipe(app, member, 'usr_000000000000000000000000')).status).toBe(404);
    expect((await swipe(app, member, blocked.id)).status).toBe(404);
  });

  it('validates the action', async () => {
    const member = await createMember();
    const target = await createMember();
    const res = await swipe(app, member, target.id, 'MAYBE');
    expect(res.body.error.details).toEqual([{ field: 'action', reason: 'INVALID' }]);
  });

  it('stops free members after 50 likes in 24 hours', async () => {
    const member = await createMember();
    const target = await createMember();
    await insertRecentSwipes(member.id, 'LIKE', 50);

    const res = await swipe(app, member, target.id, 'LIKE');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', details: [{ field: 'quota', reason: 'DAILY_LIKES_EXHAUSTED' }] });
    expect((await swipe(app, member, target.id, 'PASS')).status).toBe(200);
  });

  it('allows 1 free super-like per 24 hours', async () => {
    const member = await createMember();
    const first = await createMember();
    const second = await createMember();
    expect((await swipe(app, member, first.id, 'SUPER_LIKE')).status).toBe(200);
    const res = await swipe(app, member, second.id, 'SUPER_LIKE');
    expect(res.body.error.details).toEqual([{ field: 'quota', reason: 'DAILY_SUPER_LIKES_EXHAUSTED' }]);
  });

  it('does not count likes older than 24 hours, and uses the admin setting', async () => {
    const member = await createMember();
    const target = await createMember();
    await insertRecentSwipes(member.id, 'LIKE', 50);
    await Swipe.collection.updateMany({ userId: member.id }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    expect((await swipe(app, member, target.id, 'LIKE')).status).toBe(200);

    await AppSetting.create({ key: 'freeDailyLikes', value: 1 });
    const another = await createMember();
    expect((await swipe(app, member, another.id, 'LIKE')).status).toBe(403);
  });

  it('gives premium members unlimited likes', async () => {
    const member = await createMember();
    const target = await createMember();
    await grantPremium(member.id);
    await insertRecentSwipes(member.id, 'LIKE', 60);
    expect((await swipe(app, member, target.id, 'LIKE')).status).toBe(200);
  });

  it('limits swipes to 120 per minute', async () => {
    const member = await createMember();
    const requests = Array.from({ length: 120 }, () => swipe(app, member, 'usr_000000000000000000000000', 'PASS'));
    await Promise.all(requests);
    expect((await swipe(app, member, 'usr_000000000000000000000000', 'PASS')).status).toBe(429);
  });
});

describe('POST /swipes/undo', () => {
  useTestDatabase();

  it('requires a subscription', async () => {
    const member = await createMember();
    const res = await request(app).post('/api/v1/swipes/undo').set(bearer(member.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('restores the last swiped profile for premium members', async () => {
    const member = await createMember();
    const target = await createMember({ profile: { displayName: 'Avery' } });
    await grantPremium(member.id);
    await swipe(app, member, target.id, 'PASS');

    const res = await request(app).post('/api/v1/swipes/undo').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.restoredProfile).toMatchObject({ id: target.id, displayName: 'Avery' });
    expect(await Swipe.countDocuments({ userId: member.id })).toBe(0);
  });

  it('answers 404 when there is nothing to undo and 409 for a match', async () => {
    const member = await createMember();
    const target = await createMember();
    await grantPremium(member.id);
    expect((await request(app).post('/api/v1/swipes/undo').set(bearer(member.token))).status).toBe(404);

    await swipe(app, target, member.id, 'LIKE');
    await swipe(app, member, target.id, 'LIKE');
    expect((await request(app).post('/api/v1/swipes/undo').set(bearer(member.token))).status).toBe(409);
  });
});
