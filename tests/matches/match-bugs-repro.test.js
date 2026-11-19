// Reproduction probes for Match System scenarios. Each case asserts observed behaviour;
// failures here mean a confirmed bug (or a regression after a fix).

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { Notification } from '../../src/models/Notification.js';
import { Swipe } from '../../src/models/Swipe.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';
import * as swipeService from '../../src/services/swipe.service.js';
import * as matchService from '../../src/services/match.service.js';

const app = createApp();

describe('match system bug reproductions', () => {
  useTestDatabase();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent mutual likes create one match, one conversation, and exactly two NEW_MATCH notifications', async () => {
    const a = await createMember();
    const b = await createMember();

    const [resA, resB] = await Promise.all([swipe(app, a, b.id, 'LIKE'), swipe(app, b, a.id, 'LIKE')]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.isMatch || resB.body.data.isMatch).toBe(true);
    expect(await Match.countDocuments()).toBe(1);
    expect(await Conversation.countDocuments()).toBe(1);
    expect(await Notification.countDocuments({ type: 'NEW_MATCH' })).toBe(2);
    expect(await Notification.countDocuments({ userId: a.id, type: 'NEW_MATCH' })).toBe(1);
    expect(await Notification.countDocuments({ userId: b.id, type: 'NEW_MATCH' })).toBe(1);
  });

  it('duplicate like-back / second swipe is rejected without a second match', async () => {
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');
    const first = await swipe(app, b, a.id, 'LIKE');
    const second = await swipe(app, b, a.id, 'LIKE');
    expect(first.body.data.isMatch).toBe(true);
    expect(second.status).toBe(409);
    expect(await Match.countDocuments()).toBe(1);
    expect(await Conversation.countDocuments()).toBe(1);
  });

  it('unmatch closes only that pair conversation and removes the match for both', async () => {
    const me = await createMember();
    const first = await createMember();
    const second = await createMember();
    const match1 = await matchMembers(app, me, first);
    const match2 = await matchMembers(app, me, second);

    const res = await request(app).post(`/api/v1/matches/${match1.id}/unmatch`).set(bearer(me.token));
    expect(res.status).toBe(200);

    expect((await Match.findById(match1.id)).status).toBe('ENDED');
    expect((await Conversation.findById(match1.conversationId)).status).toBe('CLOSED');
    expect((await Match.findById(match2.id)).status).toBe('ACTIVE');
    expect((await Conversation.findById(match2.conversationId)).status).toBe('ACTIVE');

    const mine = await request(app).get('/api/v1/matches').set(bearer(me.token));
    const theirs = await request(app).get('/api/v1/matches').set(bearer(first.token));
    expect(mine.body.data.items.map((m) => m.id)).toEqual([match2.id]);
    expect(theirs.body.data.items).toEqual([]);
  });

  it('blocked members cannot create a mutual match', async () => {
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');
    await request(app).post(`/api/v1/users/${b.id}/block`).set(bearer(a.token));
    const res = await swipe(app, b, a.id, 'LIKE');
    expect(res.status).toBe(404);
    expect(await Match.countDocuments()).toBe(0);
  });

  it('free members cannot read Liked You list identities', async () => {
    const member = await createMember();
    const liker = await createMember({ profile: { displayName: 'SecretLiker' } });
    await swipe(app, liker, member.id, 'LIKE');
    const res = await request(app).get('/api/v1/likes/received').set(bearer(member.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(JSON.stringify(res.body)).not.toContain('SecretLiker');
    expect(JSON.stringify(res.body)).not.toContain(liker.id);
  });

  it('GET /matches does not return duplicates for the same pair', async () => {
    const a = await createMember();
    const b = await createMember();
    await matchMembers(app, a, b);
    await matchService.createMatchForMutualLike(a.id, b.id);
    const res = await request(app).get('/api/v1/matches').set(bearer(a.token));
    expect(res.body.data.items).toHaveLength(1);
    expect(await Match.countDocuments()).toBe(1);
  });

  it('undo refuses after the last swipe is linked to a match', async () => {
    const a = await createMember();
    const b = await createMember();
    await grantPremium(a.id);
    await swipe(app, a, b.id, 'LIKE');
    await swipe(app, b, a.id, 'LIKE');
    await expect(swipeService.undoLastSwipe(a.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Swipe.countDocuments({ userId: a.id })).toBe(1);
    expect((await Match.findOne()).status).toBe('ACTIVE');
  });

  it('createMatchForMutualLike returns null when a like was undone before both sides link', async () => {
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');
    await Swipe.create({ userId: b.id, targetUserId: a.id, action: 'LIKE' });
    await Swipe.deleteOne({ userId: a.id, targetUserId: b.id });
    const match = await matchService.createMatchForMutualLike(b.id, a.id);
    expect(match).toBeNull();
    expect(await Match.countDocuments()).toBe(0);
    expect(await Conversation.countDocuments()).toBe(0);
  });

  it('undo cannot delete a swipe after a concurrent mutual like links it (atomic matchId guard)', async () => {
    const a = await createMember();
    const b = await createMember();
    await grantPremium(a.id);
    await swipe(app, a, b.id, 'LIKE');
    await swipe(app, b, a.id, 'LIKE');

    // Both likes exist and the match is linked — undo must refuse and keep both swipes.
    await expect(swipeService.undoLastSwipe(a.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Swipe.countDocuments({ userId: a.id, targetUserId: b.id })).toBe(1);
    expect(await Match.countDocuments({ status: 'ACTIVE' })).toBe(1);

    // Forced interleaving: hold findOneAndDelete until matchId is set, then ensure undo fails.
    const original = Swipe.findOneAndDelete.bind(Swipe);
    let released;
    const hold = new Promise((resolve) => {
      released = resolve;
    });
    let calls = 0;
    vi.spyOn(Swipe, 'findOneAndDelete').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) {
        return {
          then: (onFulfilled, onRejected) =>
            hold
              .then(() => original(...args))
              .then(onFulfilled, onRejected),
        };
      }
      return original(...args);
    });

    const c = await createMember();
    const d = await createMember();
    await grantPremium(c.id);
    await swipe(app, c, d.id, 'LIKE');

    const undoPromise = swipeService.undoLastSwipe(c.id);
    await new Promise((r) => setTimeout(r, 20));
    await swipe(app, d, c.id, 'LIKE');
    expect((await Swipe.findOne({ userId: c.id })).matchId).toBeTruthy();
    released();

    await expect(undoPromise).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Swipe.countDocuments({ userId: c.id, targetUserId: d.id })).toBe(1);
    expect(await Match.countDocuments({ userIds: c.id, status: 'ACTIVE' })).toBe(1);
  });

  it('outsider cannot get or unmatch someone else\'s match', async () => {
    const a = await createMember();
    const b = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, a, b);
    expect((await request(app).get(`/api/v1/matches/${match.id}`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(outsider.token))).status).toBe(404);
    expect((await Match.findById(match.id)).status).toBe('ACTIVE');
  });

  it('stress: concurrent undo vs mutual like must never orphan an ACTIVE match', async () => {
    let orphaned = 0;
    for (let i = 0; i < 25; i += 1) {
      const a = await createMember();
      const b = await createMember();
      await grantPremium(a.id);
      await swipe(app, a, b.id, 'LIKE');
      await Promise.all([
        request(app).post('/api/v1/swipes/undo').set(bearer(a.token)),
        swipe(app, b, a.id, 'LIKE'),
      ]);
      const active = await Match.findOne({ status: 'ACTIVE' });
      if (!active) continue;
      const linked = await Swipe.countDocuments({
        matchId: active._id,
        $or: [
          { userId: a.id, targetUserId: b.id },
          { userId: b.id, targetUserId: a.id },
        ],
      });
      if (linked < 2) orphaned += 1;
    }
    expect(orphaned).toBe(0);
  });
});
