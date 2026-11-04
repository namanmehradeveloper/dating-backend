// Tests GET /likes/received (premium, with the free-tier count) and GET /likes/sent.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';
import { swipe } from '../helpers/social.js';

const app = createApp();

describe('GET /likes/received', () => {
  useTestDatabase();

  it('tells free members how many likes are waiting', async () => {
    const member = await createMember();
    await swipe(app, await createMember(), member.id, 'LIKE');
    await swipe(app, await createMember(), member.id, 'SUPER_LIKE');
    await swipe(app, await createMember(), member.id, 'PASS');

    const res = await request(app).get('/api/v1/likes/received').set(bearer(member.token));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', details: [{ field: 'likes', reason: 'COUNT_2' }] });
  });

  it('lists pending likes for premium members, excluding answered and blocked members', async () => {
    const member = await createMember();
    await grantPremium(member.id);
    const liker = await createMember({ profile: { displayName: 'Liker' } });
    const answered = await createMember();
    const blocked = await createMember();

    await swipe(app, liker, member.id, 'SUPER_LIKE');
    await swipe(app, answered, member.id, 'LIKE');
    await swipe(app, member, answered.id, 'PASS');
    await swipe(app, blocked, member.id, 'LIKE');
    await Block.create({ blockerId: member.id, blockedId: blocked.id });

    const res = await request(app).get('/api/v1/likes/received').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      { user: expect.objectContaining({ id: liker.id, displayName: 'Liker' }), action: 'SUPER_LIKE', likedAt: expect.any(String) },
    ]);
    expect(res.body.data.nextCursor).toBeNull();
  });
});

describe('GET /likes/sent', () => {
  useTestDatabase();

  it('lists likes that have not become matches', async () => {
    const member = await createMember();
    const pending = await createMember();
    const matched = await createMember();
    const passed = await createMember();

    await swipe(app, member, pending.id, 'LIKE');
    await swipe(app, member, matched.id, 'LIKE');
    await swipe(app, matched, member.id, 'LIKE');
    await swipe(app, member, passed.id, 'PASS');

    const res = await request(app).get('/api/v1/likes/sent').set(bearer(member.token));
    expect(res.body.data.items.map((item) => item.user.id)).toEqual([pending.id]);
    expect(res.body.data.items[0].action).toBe('LIKE');
  });

  it('paginates', async () => {
    const member = await createMember();
    await grantPremium(member.id);
    for (let index = 0; index < 3; index += 1) await swipe(app, member, (await createMember()).id, 'LIKE');

    const first = await request(app).get('/api/v1/likes/sent?limit=2').set(bearer(member.token));
    expect(first.body.data.items).toHaveLength(2);
    const second = await request(app).get(`/api/v1/likes/sent?limit=2&cursor=${first.body.data.nextCursor}`).set(bearer(member.token));
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
  });
});
