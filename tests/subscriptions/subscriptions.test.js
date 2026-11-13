// Subscription products, demo checkout/verify, entitlement lifecycle and provider isolation.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { periodDurationMs } from '../../src/config/catalog.js';
import { PaymentTransaction } from '../../src/models/PaymentTransaction.js';
import { SubscriptionEntitlement } from '../../src/models/SubscriptionEntitlement.js';
import { applyVerifiedEntitlement, downgradeExpiredSubscriptions } from '../../src/services/subscription.service.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

async function checkout(member, productId = 'dc_plus_monthly', platform = 'WEB') {
  const res = await request(app)
    .post('/api/v1/subscriptions/checkout')
    .set(bearer(member.token))
    .send({ productId, platform });
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('subscriptions', () => {
  useTestDatabase();

  it('lists products wrapped in items with billing status', async () => {
    const member = await createMember();
    const res = await request(app).get('/api/v1/subscriptions/products').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((product) => product.id)).toEqual(['dc_plus_monthly', 'dc_plus_yearly']);
    expect(res.body.data.items[0]).toMatchObject({
      id: 'dc_plus_monthly',
      tier: 'PLUS',
      period: 'MONTHLY',
      amountMinor: 49900,
      currency: 'INR',
    });
    expect(res.body.data.billing).toMatchObject({ configured: true, provider: 'demo' });
  });

  it('reports the free tier without an entitlement and PLUS with one', async () => {
    const member = await createMember();
    const free = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(free.body.data).toEqual({
      tier: 'FREE',
      isActive: false,
      expiresAt: null,
      willRenew: false,
      platform: null,
      provider: null,
      environment: null,
    });

    await grantPremium(member.id);
    const plus = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(plus.body.data).toMatchObject({ tier: 'PLUS', isActive: true, provider: 'demo', environment: 'demo' });
  });

  it('treats an expired entitlement as free', async () => {
    const member = await createMember();
    await SubscriptionEntitlement.create({
      userId: member.id,
      tier: 'PLUS',
      isActive: true,
      expiresAt: new Date(Date.now() - 1000),
      willRenew: true,
      platform: 'ANDROID',
      provider: 'demo',
      environment: 'demo',
    });
    const res = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(res.body.data).toMatchObject({ tier: 'FREE', isActive: false, willRenew: false });
  });

  it('creates a demo checkout and activates PLUS on simulated SUCCESS', async () => {
    const member = await createMember();
    const session = await checkout(member, 'dc_plus_monthly');
    expect(session).toMatchObject({
      provider: 'demo',
      environment: 'demo',
      status: 'PENDING',
      amountMinor: 49900,
      isDemo: true,
    });
    expect(session.clientPayload.simulateOutcomes).toEqual(['SUCCESS', 'FAILURE']);

    const verified = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });

    expect(verified.status).toBe(200);
    expect(verified.body.data.payment).toMatchObject({ status: 'SUCCEEDED', isDemo: true, provider: 'demo' });
    expect(verified.body.data.entitlement).toMatchObject({
      tier: 'PLUS',
      isActive: true,
      provider: 'demo',
      environment: 'demo',
      willRenew: true,
    });

    const expiresAt = new Date(verified.body.data.entitlement.expiresAt).getTime();
    const expected = Date.now() + periodDurationMs('MONTHLY');
    expect(Math.abs(expiresAt - expected)).toBeLessThan(10_000);

    const entitlement = await SubscriptionEntitlement.findOne({ userId: member.id }).lean();
    expect(entitlement.provider).toBe('demo');
    expect(entitlement.environment).toBe('demo');
  });

  it('sets yearly expiry for the yearly product', async () => {
    const member = await createMember();
    const session = await checkout(member, 'dc_plus_yearly');
    const verified = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });
    expect(verified.status).toBe(200);
    const expiresAt = new Date(verified.body.data.entitlement.expiresAt).getTime();
    expect(Math.abs(expiresAt - (Date.now() + periodDurationMs('YEARLY')))).toBeLessThan(10_000);
  });

  it('simulates FAILURE without granting entitlement', async () => {
    const member = await createMember();
    const session = await checkout(member);
    const verified = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'FAILURE' } });

    expect(verified.status).toBe(200);
    expect(verified.body.data.payment.status).toBe('FAILED');
    expect(verified.body.data.entitlement).toMatchObject({ tier: 'FREE', isActive: false });
    expect(await SubscriptionEntitlement.countDocuments({ userId: member.id, isActive: true })).toBe(0);
  });

  it('is idempotent on duplicate SUCCESS verification', async () => {
    const member = await createMember();
    const session = await checkout(member);
    const body = { checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } };
    const first = await request(app).post('/api/v1/subscriptions/verify').set(bearer(member.token)).send(body);
    const second = await request(app).post('/api/v1/subscriptions/verify').set(bearer(member.token)).send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.replayed).toBe(true);
    expect(await PaymentTransaction.countDocuments({ userId: member.id, status: 'SUCCEEDED' })).toBe(1);
  });

  it('rejects verifying another member checkout', async () => {
    const owner = await createMember();
    const other = await createMember();
    const session = await checkout(owner);
    const res = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(other.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });
    expect(res.status).toBe(403);
  });

  it('reuses checkout rows for the same idempotency key', async () => {
    const member = await createMember();
    const first = await request(app)
      .post('/api/v1/subscriptions/checkout')
      .set(bearer(member.token))
      .send({ productId: 'dc_plus_monthly', platform: 'WEB', idempotencyKey: 'key-1' });
    const second = await request(app)
      .post('/api/v1/subscriptions/checkout')
      .set(bearer(member.token))
      .send({ productId: 'dc_plus_monthly', platform: 'WEB', idempotencyKey: 'key-1' });
    expect(first.body.data.checkoutId).toBe(second.body.data.checkoutId);
    expect(await PaymentTransaction.countDocuments({ userId: member.id })).toBe(1);
  });

  it('cancels renewal but keeps access until expiry', async () => {
    const member = await createMember();
    const session = await checkout(member);
    await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });

    const cancelled = await request(app).post('/api/v1/subscriptions/cancel').set(bearer(member.token)).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ tier: 'PLUS', isActive: true, willRenew: false });
  });

  it('lists payment history marked as demo', async () => {
    const member = await createMember();
    const session = await checkout(member);
    await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });

    const history = await request(app).get('/api/v1/subscriptions/history').set(bearer(member.token));
    expect(history.status).toBe(200);
    expect(history.body.data.items[0]).toMatchObject({ isDemo: true, provider: 'demo', status: 'SUCCEEDED' });
  });

  it('restores demo purchases from the ledger', async () => {
    const member = await createMember();
    const session = await checkout(member);
    await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ checkoutId: session.checkoutId, providerProof: { outcome: 'SUCCESS' } });
    await SubscriptionEntitlement.deleteMany({ userId: member.id });

    const restored = await request(app)
      .post('/api/v1/subscriptions/restore')
      .set(bearer(member.token))
      .send({ platform: 'WEB' });
    expect(restored.status).toBe(200);
    expect(restored.body.data.restored).toBe(true);
    expect(restored.body.data.entitlement).toMatchObject({ tier: 'PLUS', isActive: true, provider: 'demo' });
  });

  it('accepts a signed demo webhook', async () => {
    const member = await createMember();
    const session = await checkout(member);
    const res = await request(app)
      .post('/api/v1/subscriptions/webhooks/demo')
      .set('x-demo-signature', 'test_demo_webhook_secret')
      .send({ type: 'demo.payment.updated', checkoutId: session.checkoutId, status: 'SUCCEEDED' });
    expect(res.status).toBe(200);
    expect(res.body.data.handled).toBe(true);
    expect((await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token))).body.data.tier).toBe(
      'PLUS',
    );
  });

  it('rejects an unsigned demo webhook', async () => {
    const res = await request(app)
      .post('/api/v1/subscriptions/webhooks/demo')
      .send({ checkoutId: 'chk_x', status: 'SUCCEEDED' });
    expect(res.status).toBe(403);
  });

  it('validates legacy verify bodies then answers FEATURE_NOT_CONFIGURED without granting', async () => {
    const member = await createMember();
    const invalid = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ platform: 'ANDROID', productId: 'free_forever' });
    expect(invalid.status).toBe(400);

    const res = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ platform: 'ANDROID', productId: 'dc_plus_monthly', transactionProof: 'purchase-token' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('FEATURE_NOT_CONFIGURED');
  });

  it('limits restore to 10 per hour', async () => {
    const member = await createMember();
    const body = { platform: 'WEB' };
    for (let index = 0; index < 10; index += 1) {
      await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send(body);
    }
    expect((await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send(body)).status).toBe(429);
  });

  it('requires authentication for member routes but not webhooks', async () => {
    expect((await request(app).get('/api/v1/subscriptions/entitlement')).status).toBe(401);
    expect((await request(app).post('/api/v1/subscriptions/checkout').send({})).status).toBe(401);
  });

  it('never allows demo verification context to be recorded as razorpay', async () => {
    const member = await createMember();
    await expect(
      applyVerifiedEntitlement(
        member.id,
        { tier: 'PLUS', isActive: true, provider: 'demo', expiresAt: new Date(Date.now() + 86400000) },
        { provider: 'razorpay', environment: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('downgrades expired entitlements via the shared engine', async () => {
    const member = await createMember();
    await SubscriptionEntitlement.create({
      userId: member.id,
      tier: 'PLUS',
      isActive: true,
      expiresAt: new Date(Date.now() - 1000),
      willRenew: true,
      provider: 'demo',
      environment: 'demo',
      platform: 'WEB',
    });
    expect(await downgradeExpiredSubscriptions()).toBe(1);
    const row = await SubscriptionEntitlement.findOne({ userId: member.id }).lean();
    expect(row).toMatchObject({ isActive: false, willRenew: false });
  });
});
