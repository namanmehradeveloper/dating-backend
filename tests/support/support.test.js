// Tests public FAQs and support tickets (member + guest, validation, daily limit,
// Idempotency-Key behaviour and concurrent creates/replies).

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SupportTicket } from '../../src/models/SupportTicket.js';
import { SupportTicketQuota } from '../../src/models/SupportTicketQuota.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';

const app = createApp();
const VALID_TICKET = { category: 'BUG', subject: 'App crashes', message: 'The app closes when I open chat.' };
const GUEST_TICKET = {
  ...VALID_TICKET,
  name: 'Guest User',
  email: 'guest@example.test',
};

async function memberWithEmail(overrides = {}) {
  return createMember({
    user: { email: `member_${Date.now()}_${Math.random().toString(16).slice(2)}@example.test`, ...overrides.user },
    profile: overrides.profile,
  });
}

function postTicket(token, body = VALID_TICKET, key = randomUUID()) {
  const req = request(app).post('/api/v1/support/tickets').set('Idempotency-Key', key);
  if (token) req.set(bearer(token));
  return req.send(body);
}

function postReply(token, ticketId, body, key = randomUUID()) {
  return request(app)
    .post(`/api/v1/support/tickets/${ticketId}/messages`)
    .set(bearer(token))
    .set('Idempotency-Key', key)
    .send({ body });
}

describe('support', () => {
  useTestDatabase();

  it('serves FAQs without signing in', async () => {
    const res = await request(app).get('/api/v1/support/faqs');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items[0]).toEqual({ id: expect.any(String), category: expect.any(String), question: expect.any(String), answer: expect.any(String) });
  });

  it('opens a ticket and returns it to its owner only', async () => {
    const member = await memberWithEmail({ profile: { displayName: 'Owner' } });
    const created = await postTicket(member.token);
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({
      id: expect.stringMatching(/^tkt_/),
      category: 'BUG',
      subject: 'App crashes',
      status: 'OPEN',
      contactName: 'Owner',
      contactEmail: member.user.email,
      createdAt: expect.any(String),
      messages: [{ id: expect.stringMatching(/^tkm_/), author: 'USER', body: VALID_TICKET.message, createdAt: expect.any(String) }],
    });

    const stored = await SupportTicket.findById(created.body.data.id).lean();
    expect(stored.userId).toBe(member.id);
    expect(stored.contactName).toBe('Owner');
    expect(stored.contactEmail).toBe(member.user.email);
    expect(stored.idempotencyKey).toEqual(expect.any(String));

    const own = await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(member.token));
    expect(own.body.data).toEqual(created.body.data);

    const other = await memberWithEmail();
    expect((await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(other.token))).status).toBe(404);
  });

  it('backfills contact details and accepts authenticated overrides', async () => {
    const member = await memberWithEmail({ profile: { displayName: 'Backfill Name' } });
    const backfilled = await postTicket(member.token);
    expect(backfilled.status).toBe(201);
    expect(backfilled.body.data.contactName).toBe('Backfill Name');
    expect(backfilled.body.data.contactEmail).toBe(member.user.email);

    const overridden = await postTicket(member.token, {
      ...VALID_TICKET,
      name: 'Override Name',
      email: 'override@example.test',
    });
    expect(overridden.status).toBe(201);
    expect(overridden.body.data.contactName).toBe('Override Name');
    expect(overridden.body.data.contactEmail).toBe('override@example.test');
  });

  it('creates guest tickets without auth and stores null userId', async () => {
    const created = await postTicket(null, GUEST_TICKET);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      category: 'BUG',
      subject: 'App crashes',
      status: 'OPEN',
      contactName: 'Guest User',
      contactEmail: 'guest@example.test',
    });

    const stored = await SupportTicket.findById(created.body.data.id).lean();
    expect(stored.userId).toBeNull();
    expect(stored.contactName).toBe('Guest User');
    expect(stored.contactEmail).toBe('guest@example.test');
    expect(stored.messages[0].authorId).toBe('guest');
  });

  it('requires Idempotency-Key, name and email for guests and validates formats', async () => {
    const missingKey = await request(app).post('/api/v1/support/tickets').send(GUEST_TICKET);
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'Idempotency-Key', reason: 'REQUIRED' }]),
    );

    const missing = await postTicket(null, VALID_TICKET);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'name', reason: 'REQUIRED' },
        { field: 'email', reason: 'REQUIRED' },
      ]),
    );

    const invalid = await postTicket(null, { ...VALID_TICKET, name: 'A', email: 'not-an-email' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual(expect.arrayContaining([{ field: 'email', reason: 'INVALID_FORMAT' }]));
  });

  it('validates the ticket', async () => {
    const member = await memberWithEmail();
    const res = await postTicket(member.token, { category: 'LOVE', subject: 'Hi', message: 'short' });
    expect(res.body.error.details).toEqual([
      { field: 'category', reason: 'UNKNOWN_OPTION' },
      { field: 'subject', reason: 'LENGTH_3_120' },
      { field: 'message', reason: 'LENGTH_10_5000' },
    ]);
  });

  it('allows 5 tickets per day for members', async () => {
    const member = await memberWithEmail();
    for (let index = 0; index < 5; index += 1) {
      expect((await postTicket(member.token)).status).toBe(201);
    }
    const limited = await postTicket(member.token);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('allows 5 guest tickets per day by IP', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await postTicket(null, { ...GUEST_TICKET, email: `guest${index}@example.test` })).status).toBe(201);
    }
    const limited = await postTicket(null, { ...GUEST_TICKET, email: 'guest6@example.test' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('lists only the member own tickets and supports follow-up replies', async () => {
    const member = await memberWithEmail({ profile: { displayName: 'Owner' } });
    const other = await memberWithEmail();
    const created = await postTicket(member.token);
    expect(created.status).toBe(201);
    await postTicket(other.token);

    const list = await request(app).get('/api/v1/support/tickets').set(bearer(member.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({
      id: created.body.data.id,
      subject: 'App crashes',
      status: 'OPEN',
      messageCount: 1,
      lastMessageAuthor: 'USER',
    });

    const reply = await postReply(member.token, created.body.data.id, 'Adding more details about the crash.');
    expect(reply.status).toBe(201);
    expect(reply.body.data.status).toBe('IN_PROGRESS');
    expect(reply.body.data.messages).toHaveLength(2);
    expect(reply.body.data.messages[1]).toMatchObject({ author: 'USER', body: 'Adding more details about the crash.' });

    expect((await postReply(other.token, created.body.data.id, 'Should not work on someone else ticket.')).status).toBe(404);
  });

  it('rejects member replies on closed tickets and guest list access', async () => {
    const member = await memberWithEmail();
    const created = await postTicket(member.token);
    await SupportTicket.updateOne({ _id: created.body.data.id }, { $set: { status: 'CLOSED' } });

    const reply = await postReply(member.token, created.body.data.id, 'Can I still reply here please?');
    expect(reply.status).toBe(409);

    expect((await request(app).get('/api/v1/support/tickets')).status).toBe(401);
  });

  it('replays the same ticket create Idempotency-Key without creating another ticket or consuming quota', async () => {
    const member = await memberWithEmail();
    const key = randomUUID();
    const first = await postTicket(member.token, VALID_TICKET, key);
    expect(first.status).toBe(201);
    const second = await postTicket(member.token, VALID_TICKET, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await SupportTicket.countDocuments({ userId: member.id })).toBe(1);
    expect((await SupportTicketQuota.findOne({ key: `user:${member.id}` })).count).toBe(1);

    for (let index = 0; index < 4; index += 1) {
      expect((await postTicket(member.token)).status).toBe(201);
    }
    expect((await postTicket(member.token)).status).toBe(429);
  });

  it('returns 409 when the same Idempotency-Key is reused with a different ticket payload', async () => {
    const member = await memberWithEmail();
    const key = randomUUID();
    expect((await postTicket(member.token, VALID_TICKET, key)).status).toBe(201);
    const conflict = await postTicket(member.token, { ...VALID_TICKET, subject: 'Different subject here' }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'Idempotency-Key', reason: 'REUSED' }]),
    );
    expect(await SupportTicket.countDocuments({ userId: member.id })).toBe(1);
  });

  it('replays the same reply Idempotency-Key without inserting a duplicate message', async () => {
    const member = await memberWithEmail();
    const created = await postTicket(member.token);
    const key = randomUUID();
    const first = await postReply(member.token, created.body.data.id, 'Same follow-up details here.', key);
    const second = await postReply(member.token, created.body.data.id, 'Same follow-up details here.', key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.messages).toHaveLength(2);
    expect(second.body.data.messages[1].id).toBe(first.body.data.messages[1].id);
    expect(await SupportTicket.findById(created.body.data.id).then((doc) => doc.messages.length)).toBe(2);
  });

  it('returns 409 when the same reply Idempotency-Key is reused with a different body', async () => {
    const member = await memberWithEmail();
    const created = await postTicket(member.token);
    const key = randomUUID();
    expect((await postReply(member.token, created.body.data.id, 'First version of the reply text.', key)).status).toBe(201);
    const conflict = await postReply(member.token, created.body.data.id, 'Changed version of the reply text.', key);
    expect(conflict.status).toBe(409);
    expect(await SupportTicket.findById(created.body.data.id).then((doc) => doc.messages.length)).toBe(2);
  });

  it('allows only one success when two concurrent ticket creates race near the daily limit', async () => {
    const member = await memberWithEmail();
    for (let index = 0; index < 4; index += 1) {
      expect((await postTicket(member.token)).status).toBe(201);
    }

    const [a, b] = await Promise.all([postTicket(member.token), postTicket(member.token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 429]);
    expect(await SupportTicket.countDocuments({ userId: member.id })).toBe(5);
    expect((await SupportTicketQuota.findOne({ key: `user:${member.id}` })).count).toBe(5);
  });

  it('dedupes concurrent ticket creates that share one Idempotency-Key', async () => {
    const member = await memberWithEmail();
    const key = randomUUID();
    const results = await Promise.all([
      postTicket(member.token, VALID_TICKET, key),
      postTicket(member.token, VALID_TICKET, key),
    ]);
    const success = results.filter((res) => res.status === 201);
    const conflicts = results.filter((res) => res.status === 409);
    expect(success.length + conflicts.length).toBe(2);
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(await SupportTicket.countDocuments({ userId: member.id })).toBe(1);
    if (success.length === 2) {
      expect(success[0].body.data.id).toBe(success[1].body.data.id);
    }
  });

  it('dedupes concurrent reply requests that share one Idempotency-Key', async () => {
    const member = await memberWithEmail();
    const created = await postTicket(member.token);
    const key = randomUUID();
    const results = await Promise.all([
      postReply(member.token, created.body.data.id, 'Concurrent follow-up about the crash.', key),
      postReply(member.token, created.body.data.id, 'Concurrent follow-up about the crash.', key),
    ]);
    const success = results.filter((res) => res.status === 201);
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(await SupportTicket.findById(created.body.data.id).then((doc) => doc.messages.length)).toBe(2);
  });
});
