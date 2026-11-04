// Tests subscription products, the server-side entitlement, and that store verification is
// validated and then honestly reported as FEATURE_NOT_CONFIGURED (never faked).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SubscriptionEntitlement } from '../../src/models/SubscriptionEntitlement.js';
import { bearer, createMember, grantPremium, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('subscriptions', () => {
  useTestDatabase();

  it('lists products wrapped in items', async () => {
    const member = await createMember();
    const res = await request(app).get('/api/v1/subscriptions/products').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((product) => product.id)).toEqual(['dc_plus_monthly', 'dc_plus_yearly']);
    expect(res.body.data.items[0]).toEqual({
      id: 'dc_plus_monthly',
      tier: 'PLUS',
      title: expect.any(String),
      description: expect.any(String),
      priceLabel: expect.any(String),
      period: 'MONTHLY',
    });
  });

  it('reports the free tier without an entitlement and PLUS with one', async () => {
    const member = await createMember();
    const free = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(free.body.data).toEqual({ tier: 'FREE', isActive: false, expiresAt: null, willRenew: false, platform: null });

    await grantPremium(member.id);
    const plus = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(plus.body.data).toMatchObject({ tier: 'PLUS', isActive: true });
  });

  it('treats an expired entitlement as free', async () => {
    const member = await createMember();
    await SubscriptionEntitlement.create({ userId: member.id, tier: 'PLUS', isActive: true, expiresAt: new Date(Date.now() - 1000), willRenew: true, platform: 'ANDROID' });
    const res = await request(app).get('/api/v1/subscriptions/entitlement').set(bearer(member.token));
    expect(res.body.data).toMatchObject({ tier: 'FREE', isActive: false, willRenew: false });
  });

  it('validates verify requests, then answers 501 FEATURE_NOT_CONFIGURED without granting anything', async () => {
    const member = await createMember();
    const invalid = await request(app).post('/api/v1/subscriptions/verify').set(bearer(member.token)).send({ platform: 'ANDROID', productId: 'free_forever' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual([
      { field: 'productId', reason: 'UNKNOWN_OPTION' },
      { field: 'transactionProof', reason: 'REQUIRED' },
    ]);

    const res = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(bearer(member.token))
      .send({ platform: 'ANDROID', productId: 'dc_plus_monthly', transactionProof: 'purchase-token' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('FEATURE_NOT_CONFIGURED');
    expect(await SubscriptionEntitlement.countDocuments()).toBe(0);
  });

  it('validates restore requests, then answers 501', async () => {
    const member = await createMember();
    const invalid = await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send({ platform: 'IOS', transactionProofs: [] });
    expect(invalid.body.error.details).toEqual([{ field: 'transactionProofs', reason: 'COUNT_1_20' }]);

    const res = await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send({ platform: 'IOS', transactionProofs: ['jws'] });
    expect(res.status).toBe(501);
  });

  it('limits restore to 10 per hour', async () => {
    const member = await createMember();
    const body = { platform: 'IOS', transactionProofs: ['jws'] };
    for (let index = 0; index < 10; index += 1) {
      await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send(body);
    }
    expect((await request(app).post('/api/v1/subscriptions/restore').set(bearer(member.token)).send(body)).status).toBe(429);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/subscriptions/entitlement')).status).toBe(401);
  });
});
