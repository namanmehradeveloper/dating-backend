// Tests public FAQs and member support tickets (validation, ownership, daily limit).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';

const app = createApp();
const VALID_TICKET = { category: 'BUG', subject: 'App crashes', message: 'The app closes when I open chat.' };

describe('support', () => {
  useTestDatabase();

  it('serves FAQs without signing in', async () => {
    const res = await request(app).get('/api/v1/support/faqs');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items[0]).toEqual({ id: expect.any(String), category: expect.any(String), question: expect.any(String), answer: expect.any(String) });
  });

  it('opens a ticket and returns it to its owner only', async () => {
    const member = await createMember();
    const created = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET);
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({
      id: expect.stringMatching(/^tkt_/),
      category: 'BUG',
      subject: 'App crashes',
      status: 'OPEN',
      createdAt: expect.any(String),
      messages: [{ id: expect.stringMatching(/^tkm_/), author: 'USER', body: VALID_TICKET.message, createdAt: expect.any(String) }],
    });

    const own = await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(member.token));
    expect(own.body.data).toEqual(created.body.data);

    const other = await createMember();
    expect((await request(app).get(`/api/v1/support/tickets/${created.body.data.id}`).set(bearer(other.token))).status).toBe(404);
  });

  it('validates the ticket', async () => {
    const member = await createMember();
    const res = await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send({ category: 'LOVE', subject: 'Hi', message: 'short' });
    expect(res.body.error.details).toEqual([
      { field: 'category', reason: 'UNKNOWN_OPTION' },
      { field: 'subject', reason: 'LENGTH_3_120' },
      { field: 'message', reason: 'LENGTH_10_5000' },
    ]);
  });

  it('allows 5 tickets per day', async () => {
    const member = await createMember();
    for (let index = 0; index < 5; index += 1) {
      expect((await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET)).status).toBe(201);
    }
    expect((await request(app).post('/api/v1/support/tickets').set(bearer(member.token)).send(VALID_TICKET)).status).toBe(429);
  });
});
