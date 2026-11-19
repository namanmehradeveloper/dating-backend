// Regression: NEW_LIKE notification must stay consistent with GET /likes/received,
// and the A → B → like-back match flow must clear pending lists.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Notification } from '../../src/models/Notification.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';
import { swipe } from '../helpers/social.js';

const app = createApp();

describe('Liked you flow regression', () => {
  useTestDatabase();

  it('A likes B → NEW_LIKE → premium B sees A in Liked you → like back clears pending lists', async () => {
    const a = await createMember({ profile: { displayName: 'Alice' } });
    const b = await createMember({ profile: { displayName: 'Blake' } });
    await grantPremium(b.id);

    const likeRes = await swipe(app, a, b.id, 'LIKE');
    expect(likeRes.status).toBe(200);
    expect(likeRes.body.data).toMatchObject({ isMatch: false, match: null });

    const notifications = await Notification.find({ userId: b.id, type: 'NEW_LIKE' }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe('Someone new liked your profile.');

    const freeGate = await request(app).get('/api/v1/likes/received').set(bearer(a.token));
    // Control: free A with no incoming likes still gets the paywall, not an empty 200 list.
    expect(freeGate.status).toBe(403);
    expect(freeGate.body.error).toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
      details: [{ field: 'likes', reason: 'COUNT_0' }],
    });

    const receivedBefore = await request(app).get('/api/v1/likes/received?limit=50').set(bearer(b.token));
    expect(receivedBefore.status).toBe(200);
    expect(receivedBefore.body.data.items).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        user: expect.objectContaining({ id: a.id, displayName: 'Alice' }),
        action: 'LIKE',
        likedAt: expect.any(String),
      }),
    ]);
    expect(receivedBefore.body.data.nextCursor).toBeNull();

    const sentBefore = await request(app).get('/api/v1/likes/sent?limit=50').set(bearer(a.token));
    expect(sentBefore.status).toBe(200);
    expect(sentBefore.body.data.items.map((item) => item.user.id)).toEqual([b.id]);

    const freeReceived = await request(app).get('/api/v1/likes/received').set(bearer((await createMember()).token));
    // Fresh free member after A liked B — still COUNT_0 for that third account.
    expect(freeReceived.body.error?.details?.[0]?.reason).toBe('COUNT_0');

    const likeBack = await swipe(app, b, a.id, 'LIKE');
    expect(likeBack.status).toBe(200);
    expect(likeBack.body.data.isMatch).toBe(true);
    expect(likeBack.body.data.match).toMatchObject({
      id: expect.any(String),
      conversationId: expect.any(String),
      otherUser: expect.objectContaining({ id: a.id }),
    });

    const receivedAfter = await request(app).get('/api/v1/likes/received').set(bearer(b.token));
    expect(receivedAfter.status).toBe(200);
    expect(receivedAfter.body.data.items).toEqual([]);

    const sentAfter = await request(app).get('/api/v1/likes/sent').set(bearer(a.token));
    expect(sentAfter.status).toBe(200);
    expect(sentAfter.body.data.items).toEqual([]);

    const matchesA = await request(app).get('/api/v1/matches').set(bearer(a.token));
    const matchesB = await request(app).get('/api/v1/matches').set(bearer(b.token));
    expect(matchesA.body.data.items).toHaveLength(1);
    expect(matchesB.body.data.items).toHaveLength(1);
    expect(matchesA.body.data.items[0].otherUser.id).toBe(b.id);
    expect(matchesB.body.data.items[0].otherUser.id).toBe(a.id);
  });

  it('free recipient gets COUNT_1 (not empty 200) when someone likes them', async () => {
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');

    const res = await request(app).get('/api/v1/likes/received').set(bearer(b.token));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
      details: [{ field: 'likes', reason: 'COUNT_1' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(a.id);
  });

  it('does not send NEW_LIKE when recipient already PASSed the liker (Liked you would stay empty)', async () => {
    const a = await createMember({ profile: { displayName: 'Avery' } });
    const b = await createMember();
    await grantPremium(b.id);

    expect((await swipe(app, b, a.id, 'PASS')).status).toBe(200);
    expect((await swipe(app, a, b.id, 'LIKE')).status).toBe(200);

    expect(await Notification.countDocuments({ userId: b.id, type: 'NEW_LIKE' })).toBe(0);

    const received = await request(app).get('/api/v1/likes/received').set(bearer(b.token));
    expect(received.status).toBe(200);
    expect(received.body.data.items).toEqual([]);
  });

  it('does not list or notify for a liker the recipient already soft-canceled toward', async () => {
    const a = await createMember({ profile: { displayName: 'Alex' } });
    const b = await createMember();
    await grantPremium(b.id);

    expect((await swipe(app, b, a.id, 'LIKE')).status).toBe(200);
    expect((await request(app).post(`/api/v1/likes/sent/${a.id}/cancel`).set(bearer(b.token))).status).toBe(200);

    expect((await swipe(app, a, b.id, 'LIKE')).status).toBe(200);
    expect(await Notification.countDocuments({ userId: b.id, type: 'NEW_LIKE' })).toBe(0);

    const received = await request(app).get('/api/v1/likes/received').set(bearer(b.token));
    expect(received.status).toBe(200);
    expect(received.body.data.items.map((item) => item.user.id)).toEqual([]);
  });
});
