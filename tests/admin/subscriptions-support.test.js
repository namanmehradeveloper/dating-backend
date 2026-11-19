// Tests the admin subscription overview (read-only, real data) and the support desk
// (ticket list, details, status changes, staff replies, audit entries).

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Notification } from '../../src/models/Notification.js';
import { bearer, createMember, createStaff, grantPremium, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

async function memberWithEmail(overrides = {}) {
  return createMember({
    user: { email: `payer_${Date.now()}_${Math.random().toString(16).slice(2)}@example.test`, ...overrides.user },
    profile: overrides.profile,
  });
}

describe('admin subscriptions', () => {
  useTestDatabase();

  it('lists real entitlements and filters by active state', async () => {
    const admin = await createStaff('ADMIN');
    const premium = await createMember({ profile: { displayName: 'Premium' } });
    await createMember();
    await grantPremium(premium.id);

    const res = await request(app).get('/api/v1/admin/subscriptions?isActive=true').set(bearer(admin.token));
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ userId: premium.id, tier: 'PLUS', isActive: true, productId: 'dc_plus_monthly', user: expect.objectContaining({ displayName: 'Premium' }) }),
    ]);
    expect((await request(app).get('/api/v1/admin/subscriptions?isActive=false').set(bearer(admin.token))).body.data.items).toEqual([]);
  });

  it('shows one member, including FREE members and billing provider status', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    const res = await request(app).get(`/api/v1/admin/subscriptions/${member.id}`).set(bearer(admin.token));
    expect(res.body.data).toMatchObject({
      user: { id: member.id },
      entitlement: { tier: 'FREE', isActive: false },
      storeVerification: { configured: true, status: 'CONFIGURED', provider: 'demo', environment: 'demo' },
    });
  });
});

describe('admin support', () => {
  useTestDatabase();

  // Opens a ticket as a member.
  async function openTicket(member, body = {}) {
    const res = await request(app)
      .post('/api/v1/support/tickets')
      .set(bearer(member.token))
      .set('Idempotency-Key', randomUUID())
      .send({ category: 'BILLING', subject: 'Charged twice', message: 'I was charged twice this month.', ...body });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  it('lists and shows tickets with contact details', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await memberWithEmail({ profile: { displayName: 'Payer' } });
    const ticket = await openTicket(member);

    const list = await request(app).get('/api/v1/admin/support/tickets?status=OPEN&category=BILLING').set(bearer(moderator.token));
    expect(list.body.data.items).toEqual([
      expect.objectContaining({
        id: ticket.id,
        subject: 'Charged twice',
        messageCount: 1,
        contactName: 'Payer',
        contactEmail: member.user.email,
        user: expect.objectContaining({ displayName: 'Payer' }),
      }),
    ]);

    const detail = await request(app).get(`/api/v1/admin/support/tickets/${ticket.id}`).set(bearer(moderator.token));
    expect(detail.body.data.messages).toEqual([expect.objectContaining({ author: 'USER', body: 'I was charged twice this month.' })]);
    expect(detail.body.data.contactName).toBe('Payer');
    expect(detail.body.data.contactEmail).toBe(member.user.email);
  });

  it('lists guest tickets and skips in-app notify on reply', async () => {
    const moderator = await createStaff('MODERATOR');
    const created = await request(app)
      .post('/api/v1/support/tickets')
      .set('Idempotency-Key', randomUUID())
      .send({
        category: 'ACCOUNT',
        subject: 'Need help signing in',
        message: 'I cannot access my account anymore.',
        name: 'Guest Ada',
        email: 'ada.guest@example.test',
      });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/v1/admin/support/tickets?q=ada.guest@example.test').set(bearer(moderator.token));
    expect(list.body.data.items).toEqual([
      expect.objectContaining({
        id: created.body.data.id,
        contactName: 'Guest Ada',
        contactEmail: 'ada.guest@example.test',
        user: null,
      }),
    ]);

    const reply = await request(app)
      .post(`/api/v1/admin/support/tickets/${created.body.data.id}/messages`)
      .set(bearer(moderator.token))
      .send({ body: 'Please try resetting your password.' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.status).toBe('IN_PROGRESS');
    expect(reply.body.data.user).toBeNull();
    expect(await Notification.countDocuments({})).toBe(0);
    expect(await AuditLog.exists({ action: 'TICKET_REPLIED', targetId: created.body.data.id })).toBeTruthy();

    const closed = await request(app)
      .patch(`/api/v1/admin/support/tickets/${created.body.data.id}`)
      .set(bearer(moderator.token))
      .send({ status: 'CLOSED' });
    expect(closed.body.data.status).toBe('CLOSED');
  });

  it('replies as staff, notifies the member and hides staff identity from them', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await memberWithEmail();
    const ticket = await openTicket(member);

    const reply = await request(app).post(`/api/v1/admin/support/tickets/${ticket.id}/messages`).set(bearer(moderator.token)).send({ body: 'We refunded the second charge.' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.status).toBe('IN_PROGRESS');
    expect(reply.body.data.messages[1]).toMatchObject({ author: 'STAFF', authorUser: { id: moderator.id } });
    expect(await Notification.exists({ userId: member.id, type: 'SYSTEM' })).toBeTruthy();

    const memberView = await request(app).get(`/api/v1/support/tickets/${ticket.id}`).set(bearer(member.token));
    expect(memberView.body.data.messages[1]).toEqual({ id: expect.any(String), author: 'STAFF', body: 'We refunded the second charge.', createdAt: expect.any(String) });
    expect(JSON.stringify(memberView.body)).not.toContain(moderator.id);

    expect(await AuditLog.exists({ action: 'TICKET_REPLIED', targetId: ticket.id })).toBeTruthy();
  });

  it('changes status, and refuses replies on closed tickets', async () => {
    const moderator = await createStaff('MODERATOR');
    const ticket = await openTicket(await memberWithEmail());

    const closed = await request(app).patch(`/api/v1/admin/support/tickets/${ticket.id}`).set(bearer(moderator.token)).send({ status: 'CLOSED' });
    expect(closed.body.data.status).toBe('CLOSED');
    expect((await AuditLog.findOne({ action: 'TICKET_STATUS_CHANGED' })).metadata).toEqual({ from: 'OPEN', to: 'CLOSED' });

    const reply = await request(app).post(`/api/v1/admin/support/tickets/${ticket.id}/messages`).set(bearer(moderator.token)).send({ body: 'Hello?' });
    expect(reply.status).toBe(409);

    const invalid = await request(app).patch(`/api/v1/admin/support/tickets/${ticket.id}`).set(bearer(moderator.token)).send({ status: 'DONE' });
    expect(invalid.status).toBe(400);
  });
});
