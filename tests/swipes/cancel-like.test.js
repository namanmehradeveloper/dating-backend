// Tests POST /likes/sent/:targetUserId/cancel — cancel pending outgoing LIKE / SUPER_LIKE.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { Notification } from '../../src/models/Notification.js';
import { Swipe } from '../../src/models/Swipe.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';

const app = createApp();

function cancelLike(member, targetUserId) {
  return request(app).post(`/api/v1/likes/sent/${targetUserId}/cancel`).set(bearer(member.token));
}

describe('POST /likes/sent/:targetUserId/cancel', () => {
  useTestDatabase();

  it('cancels a pending LIKE and removes it from sent and received lists', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    await grantPremium(recipient.id);

    await swipe(app, sender, recipient.id, 'LIKE');
    expect((await request(app).get('/api/v1/likes/sent').set(bearer(sender.token))).body.data.items.map((i) => i.user.id)).toEqual([
      recipient.id,
    ]);
    expect(
      (await request(app).get('/api/v1/likes/received').set(bearer(recipient.token))).body.data.items.map((i) => i.user.id),
    ).toEqual([sender.id]);

    const res = await cancelLike(sender, recipient.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ canceled: true, targetUserId: recipient.id, action: 'LIKE' });

    const swipeRow = await Swipe.findOne({ userId: sender.id, targetUserId: recipient.id }).lean();
    expect(swipeRow.canceledAt).toBeTruthy();
    expect(swipeRow.matchId).toBeFalsy();

    expect((await request(app).get('/api/v1/likes/sent').set(bearer(sender.token))).body.data.items).toEqual([]);
    expect((await request(app).get('/api/v1/likes/received').set(bearer(recipient.token))).body.data.items).toEqual([]);
  });

  it('cancels a pending SUPER_LIKE', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    await swipe(app, sender, recipient.id, 'SUPER_LIKE');

    const res = await cancelLike(sender, recipient.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ canceled: true, action: 'SUPER_LIKE', targetUserId: recipient.id });
    expect((await request(app).get('/api/v1/likes/sent').set(bearer(sender.token))).body.data.items).toEqual([]);
  });

  it('refuses to cancel another user\'s swipe', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    const stranger = await createMember();
    await swipe(app, sender, recipient.id, 'LIKE');

    const res = await cancelLike(stranger, recipient.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const swipeRow = await Swipe.findOne({ userId: sender.id, targetUserId: recipient.id }).lean();
    expect(swipeRow.canceledAt).toBeFalsy();
  });

  it('refuses cancellation after a Match exists and does not delete Match or Conversation', async () => {
    const a = await createMember();
    const b = await createMember();
    const match = await matchMembers(app, a, b);

    const res = await cancelLike(a, b.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    expect(await Match.countDocuments({ _id: match.id, status: 'ACTIVE' })).toBe(1);
    expect(await Conversation.countDocuments({ matchId: match.id })).toBe(1);
    expect(await Swipe.countDocuments({ matchId: match.id, canceledAt: null })).toBe(2);
  });

  it('answers 409 on duplicate cancellation', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    await swipe(app, sender, recipient.id, 'LIKE');

    expect((await cancelLike(sender, recipient.id)).status).toBe(200);
    const again = await cancelLike(sender, recipient.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('answers 404 when there is no pending like', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    const res = await cancelLike(sender, recipient.id);
    expect(res.status).toBe(404);
  });

  it('preserves daily like quota after cancel (soft-cancel keeps the swipe row)', async () => {
    const sender = await createMember();
    const first = await createMember();
    const second = await createMember();
    await swipe(app, sender, first.id, 'LIKE');
    await cancelLike(sender, first.id);

    // Free daily likes default is low; after cancel the row still counts toward quota.
    const used = await Swipe.countDocuments({
      userId: sender.id,
      action: 'LIKE',
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    expect(used).toBe(1);

    // Unique index still blocks a second swipe at the same target.
    expect((await swipe(app, sender, first.id, 'LIKE')).status).toBe(409);
    // A new target still consumes a fresh quota slot as before.
    expect((await swipe(app, sender, second.id, 'LIKE')).status).toBe(200);
  });

  it('clears only that sender NEW_LIKE notification and keeps unrelated ones', async () => {
    const sender = await createMember();
    const recipient = await createMember();
    const other = await createMember();
    await swipe(app, sender, recipient.id, 'LIKE');
    await swipe(app, other, recipient.id, 'LIKE');

    const before = await Notification.countDocuments({ userId: recipient.id, type: 'NEW_LIKE' });
    expect(before).toBe(2);

    await cancelLike(sender, recipient.id);

    const remaining = await Notification.find({ userId: recipient.id, type: 'NEW_LIKE' }).lean();
    expect(remaining).toHaveLength(1);
    const fromUserId = remaining[0].data?.fromUserId ?? remaining[0].data?.get?.('fromUserId');
    expect(fromUserId).toBe(other.id);
  });

  it('handles concurrent Like Back and Unlike safely (no orphan ACTIVE match)', async () => {
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');

    const [likeBack, unlike] = await Promise.all([
      swipe(app, b, a.id, 'LIKE'),
      cancelLike(a, b.id),
    ]);

    const statuses = [likeBack.status, unlike.status].sort();
    // One side succeeds cleanly; the other is either success (cancel won → no match) or 409 (match won).
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);

    const activeMatches = await Match.countDocuments({ userIds: a.id, status: 'ACTIVE' });
    const aSwipe = await Swipe.findOne({ userId: a.id, targetUserId: b.id }).lean();

    if (activeMatches === 1) {
      expect(unlike.status).toBe(409);
      expect(likeBack.body.data.isMatch).toBe(true);
      expect(aSwipe.matchId).toBeTruthy();
      expect(aSwipe.canceledAt).toBeFalsy();
      expect(await Conversation.countDocuments({ matchId: aSwipe.matchId })).toBe(1);
    } else {
      expect(activeMatches).toBe(0);
      expect(unlike.status).toBe(200);
      expect(aSwipe.canceledAt).toBeTruthy();
      expect(aSwipe.matchId).toBeFalsy();
      expect(likeBack.body.data.isMatch).toBe(false);
      expect(await Match.countDocuments({ userIds: a.id })).toBe(0);
    }
  });

  it('leaves undo behaviour intact after canceling an older pending like', async () => {
    const member = await createMember();
    await grantPremium(member.id);
    const older = await createMember();
    const newer = await createMember({ profile: { displayName: 'Newest' } });

    await swipe(app, member, older.id, 'LIKE');
    await swipe(app, member, newer.id, 'PASS');
    expect((await cancelLike(member, older.id)).status).toBe(200);

    const undo = await request(app).post('/api/v1/swipes/undo').set(bearer(member.token));
    expect(undo.status).toBe(200);
    expect(undo.body.data.restoredProfile).toMatchObject({ id: newer.id, displayName: 'Newest' });
  });
});
