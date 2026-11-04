// Tests GET /matches, GET /matches/:matchId and POST /matches/:matchId/unmatch.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

describe('matches', () => {
  useTestDatabase();

  it('lists active matches newest first with the other member', async () => {
    const member = await createMember();
    const first = await createMember({ profile: { displayName: 'First' } });
    const second = await createMember({ profile: { displayName: 'Second' } });
    await matchMembers(app, member, first);
    await matchMembers(app, member, second);

    const res = await request(app).get('/api/v1/matches').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((match) => match.otherUser.displayName)).toEqual(['Second', 'First']);
    expect(res.body.data.items[0]).toEqual({
      id: expect.stringMatching(/^mat_/),
      otherUser: expect.objectContaining({ id: second.id }),
      matchedAt: expect.any(String),
      conversationId: expect.stringMatching(/^cnv_/),
    });
  });

  it('paginates matches', async () => {
    const member = await createMember();
    for (let index = 0; index < 3; index += 1) await matchMembers(app, member, await createMember());
    const first = await request(app).get('/api/v1/matches?limit=2').set(bearer(member.token));
    const second = await request(app).get(`/api/v1/matches?limit=2&cursor=${first.body.data.nextCursor}`).set(bearer(member.token));
    expect(first.body.data.items).toHaveLength(2);
    expect(second.body.data.items).toHaveLength(1);
  });

  it('returns one match only to participants', async () => {
    const member = await createMember();
    const other = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, member, other);

    expect((await request(app).get(`/api/v1/matches/${match.id}`).set(bearer(member.token))).body.data.id).toBe(match.id);
    expect((await request(app).get(`/api/v1/matches/${match.id}`).set(bearer(outsider.token))).status).toBe(404);
  });

  it('unmatch ends the match and closes the conversation', async () => {
    const member = await createMember();
    const other = await createMember();
    const match = await matchMembers(app, member, other);

    const res = await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();

    expect((await Match.findById(match.id)).status).toBe('ENDED');
    expect((await Conversation.findById(match.conversationId)).status).toBe('CLOSED');
    expect((await request(app).get('/api/v1/matches').set(bearer(other.token))).body.data.items).toEqual([]);
    expect((await request(app).get(`/api/v1/matches/${match.id}`).set(bearer(member.token))).status).toBe(404);
    expect((await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(member.token))).status).toBe(404);
  });

  it('outsiders cannot unmatch', async () => {
    const member = await createMember();
    const other = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, member, other);
    expect((await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(outsider.token))).status).toBe(404);
    expect((await Match.findById(match.id)).status).toBe('ACTIVE');
  });

  it('hides matches with blocked or banned members', async () => {
    const member = await createMember();
    const blocked = await createMember();
    const banned = await createMember();
    await matchMembers(app, member, blocked);
    await matchMembers(app, member, banned);
    await Block.create({ blockerId: blocked.id, blockedId: member.id });
    await User.updateOne({ _id: banned.id }, { $set: { status: 'BANNED' } });

    expect((await request(app).get('/api/v1/matches').set(bearer(member.token))).body.data.items).toEqual([]);
  });
});
