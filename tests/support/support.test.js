// Tests public FAQs and support tickets (member + guest, validation, ownership, daily limit).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SupportTicket } from '../../src/models/SupportTicket.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { resetRateLimits } from '../../src/utils/rateLimit.js';

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
    const created = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET);
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

    const own = await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(member.token));
    expect(own.body.data).toEqual(created.body.data);

    const other = await memberWithEmail();
    expect((await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(other.token))).status).toBe(404);
  });

  it('backfills contact details and accepts authenticated overrides', async () => {
    const member = await memberWithEmail({ profile: { displayName: 'Backfill Name' } });
    const backfilled = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET);
    expect(backfilled.status).toBe(201);
    expect(backfilled.body.data.contactName).toBe('Backfill Name');
    expect(backfilled.body.data.contactEmail).toBe(member.user.email);

    const overridden = await request(app)
      .post('/api/v1/support/tickets')
      .set(bearer(member.token))
      .send({ ...VALID_TICKET, name: 'Override Name', email: 'override@example.test' });
    expect(overridden.status).toBe(201);
    expect(overridden.body.data.contactName).toBe('Override Name');
    expect(overridden.body.data.contactEmail).toBe('override@example.test');
  });

  it('creates guest tickets without auth and stores null userId', async () => {
    const created = await request(app).post('/api/v1/support/tickets').send(GUEST_TICKET);
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

  it('requires name and email for guests and validates formats', async () => {
    const missing = await request(app).post('/api/v1/support/tickets').send(VALID_TICKET);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'name', reason: 'REQUIRED' },
        { field: 'email', reason: 'REQUIRED' },
      ]),
    );

    const invalid = await request(app)
      .post('/api/v1/support/tickets')
      .send({ ...VALID_TICKET, name: 'A', email: 'not-an-email' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual(expect.arrayContaining([{ field: 'email', reason: 'INVALID_FORMAT' }]));
  });

  it('validates the ticket', async () => {
    const member = await memberWithEmail();
    const res = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send({ category: 'LOVE', subject: 'Hi', message: 'short' });
    expect(res.body.error.details).toEqual([
      { field: 'category', reason: 'UNKNOWN_OPTION' },
      { field: 'subject', reason: 'LENGTH_3_120' },
      { field: 'message', reason: 'LENGTH_10_5000' },
    ]);
  });

  it('allows 5 tickets per day for members', async () => {
    const member = await memberWithEmail();
    for (let index = 0; index < 5; index += 1) {
      expect((await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET)).status).toBe(201);
    }
    expect((await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET)).status).toBe(429);
  });

  it('allows 5 guest tickets per day by IP', async () => {
    await resetRateLimits();
    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await request(app)
            .post('/api/v1/support/tickets')
            .send({ ...GUEST_TICKET, email: `guest${index}@example.test` })
        ).status,
      ).toBe(201);
    }
    expect((await request(app).post('/api/v1/support/tickets').send({ ...GUEST_TICKET, email: 'guest6@example.test' })).status).toBe(429);
  });

  it('lists only the member own tickets and supports follow-up replies', async () => {
    const member = await memberWithEmail({ profile: { displayName: 'Owner' } });
    const other = await memberWithEmail();
    const created = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET);
    expect(created.status).toBe(201);
    await request(app).post('/api/v1/support/tickets').set(bearer(other.token)).send(VALID_TICKET);

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

    const reply = await request(app)
      .post(`/api/v1/support/tickets/${created.body.data.id}/messages`)
      .set(bearer(member.token))
      .send({ body: 'Adding more details about the crash.' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.status).toBe('IN_PROGRESS');
    expect(reply.body.data.messages).toHaveLength(2);
    expect(reply.body.data.messages[1]).toMatchObject({ author: 'USER', body: 'Adding more details about the crash.' });

    expect(
      (
        await request(app)
          .post(`/api/v1/support/tickets/${created.body.data.id}/messages`)
          .set(bearer(other.token))
          .send({ body: 'Should not work on someone else ticket.' })
      ).status,
    ).toBe(404);
  });

  it('rejects member replies on closed tickets and guest list access', async () => {
    const member = await memberWithEmail();
    const created = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET);
    await SupportTicket.updateOne({ _id: created.body.data.id }, { $set: { status: 'CLOSED' } });

    const reply = await request(app)
      .post(`/api/v1/support/tickets/${created.body.data.id}/messages`)
      .set(bearer(member.token))
      .send({ body: 'Can I still reply here please?' });
    expect(reply.status).toBe(409);

    expect((await request(app).get('/api/v1/support/tickets')).status).toBe(401);
  });
});
