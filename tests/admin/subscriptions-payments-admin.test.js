// Admin subscription stats, payment ledger, plans and analytics (real Mongo data).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PaymentTransaction } from '../../src/models/PaymentTransaction.js';
import { SubscriptionEntitlement } from '../../src/models/SubscriptionEntitlement.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

async function seedDemoPurchase(member, { status = 'SUCCEEDED', amountMinor = 49900 } = {}) {
  const checkoutId = `chk_${member.id}_${status}_${amountMinor}`;
  return PaymentTransaction.create({
    userId: member.id,
    provider: 'demo',
    environment: 'demo',
    productId: 'dc_plus_monthly',
    platform: 'WEB',
    amountMinor,
    currency: 'INR',
    status,
    checkoutId,
    providerRef: `demo_${checkoutId}`,
    originalTransactionId: status === 'SUCCEEDED' ? `demo_txn_${checkoutId}` : undefined,
    period: 'MONTHLY',
    verifiedAt: status === 'SUCCEEDED' ? new Date() : undefined,
    entitlementAppliedAt: status === 'SUCCEEDED' ? new Date() : undefined,
    lifecycleEvents: [{ type: 'CHECKOUT_CREATED', at: new Date() }],
  });
}

describe('admin subscriptions & payments', () => {
  useTestDatabase();

  it('returns Free / Active Plus / Expired / Cancelled dashboard counts', async () => {
    const admin = await createStaff('ADMIN');
    const free = await createMember();
    const active = await createMember();
    const expired = await createMember();
    const cancelled = await createMember();
    void free;

    await SubscriptionEntitlement.create({
      userId: active.id,
      tier: 'PLUS',
      isActive: true,
      productId: 'dc_plus_monthly',
      provider: 'demo',
      environment: 'demo',
      platform: 'WEB',
      expiresAt: new Date(Date.now() + 86400000),
      willRenew: true,
    });
    await SubscriptionEntitlement.create({
      userId: expired.id,
      tier: 'PLUS',
      isActive: false,
      productId: 'dc_plus_monthly',
      provider: 'demo',
      environment: 'demo',
      platform: 'WEB',
      expiresAt: new Date(Date.now() - 86400000),
    });
    await SubscriptionEntitlement.create({
      userId: cancelled.id,
      tier: 'PLUS',
      isActive: true,
      productId: 'dc_plus_monthly',
      provider: 'demo',
      environment: 'demo',
      platform: 'WEB',
      expiresAt: new Date(Date.now() + 86400000),
      willRenew: false,
      cancelledAt: new Date(),
    });

    const res = await request(app).get('/api/v1/admin/subscriptions/stats').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalMembers: 4,
      free: 2,
      activePlus: 2,
      expired: 1,
      cancelled: 1,
    });
  });

  it('lists entitlements with provider, lifecycle and activation date', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember({ profile: { displayName: 'Pay User' } });
    await SubscriptionEntitlement.create({
      userId: member.id,
      tier: 'PLUS',
      isActive: true,
      productId: 'dc_plus_yearly',
      provider: 'demo',
      environment: 'demo',
      platform: 'WEB',
      expiresAt: new Date(Date.now() + 86400000),
      willRenew: true,
    });

    const res = await request(app)
      .get('/api/v1/admin/subscriptions?lifecycle=ACTIVE&provider=demo')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({
      userId: member.id,
      productId: 'dc_plus_yearly',
      provider: 'demo',
      lifecycleStatus: 'ACTIVE',
      isDemo: true,
    });
    expect(res.body.data.items[0].activatedAt).toBeTruthy();
  });

  it('lists payments with demo/real filters and never counts demo as revenue', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    await seedDemoPurchase(member, { status: 'SUCCEEDED', amountMinor: 49900 });
    await seedDemoPurchase(member, { status: 'FAILED', amountMinor: 399900 });
    await PaymentTransaction.create({
      userId: member.id,
      provider: 'razorpay',
      environment: 'test',
      productId: 'dc_plus_monthly',
      platform: 'WEB',
      amountMinor: 49900,
      currency: 'INR',
      status: 'SUCCEEDED',
      checkoutId: `chk_real_${member.id}`,
      providerRef: `rzp_${member.id}`,
      originalTransactionId: `rzp_txn_${member.id}`,
      period: 'MONTHLY',
      verifiedAt: new Date(),
    });

    const demo = await request(app).get('/api/v1/admin/payments?kind=demo').set(bearer(admin.token));
    expect(demo.body.data.items.every((row) => row.isDemo)).toBe(true);

    const real = await request(app).get('/api/v1/admin/payments?kind=real').set(bearer(admin.token));
    expect(real.body.data.items).toHaveLength(1);
    expect(real.body.data.items[0].isDemo).toBe(false);

    const stats = await request(app).get('/api/v1/admin/payments/stats?days=30').set(bearer(admin.token));
    expect(stats.body.data.revenue).toMatchObject({ amountMinor: 49900, paymentCount: 1, excludesDemo: true });
    expect(stats.body.data.demoVolume.amountMinor).toBe(49900);
  });

  it('exposes demo payment settings on payments status', async () => {
    const admin = await createStaff('ADMIN');
    const res = await request(app).get('/api/v1/admin/payments/status').set(bearer(admin.token));
    expect(res.body.data).toMatchObject({
      configured: true,
      provider: 'demo',
      demoPaymentsEnabled: true,
      demoWebhookConfigured: true,
    });
  });

  it('updates plan overrides used by the member paywall', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();

    const updated = await request(app)
      .patch('/api/v1/admin/subscriptions/plans/dc_plus_monthly')
      .set(bearer(admin.token))
      .send({ title: 'Plus Pro', priceLabel: '₹599', amountMinor: 59900, description: 'More likes.' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id: 'dc_plus_monthly', title: 'Plus Pro', amountMinor: 59900, isOverridden: true });

    const products = await request(app).get('/api/v1/subscriptions/products').set(bearer(member.token));
    expect(products.body.data.items.find((item) => item.id === 'dc_plus_monthly')).toMatchObject({
      title: 'Plus Pro',
      amountMinor: 59900,
      priceLabel: '₹599',
    });

    await request(app)
      .patch('/api/v1/admin/subscriptions/plans/dc_plus_monthly')
      .set(bearer(admin.token))
      .send({ reset: true });
  });

  it('returns analytics with demo excluded from revenue', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();
    await seedDemoPurchase(member, { status: 'SUCCEEDED' });

    const res = await request(app).get('/api/v1/admin/subscriptions/analytics?days=30').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.revenue).toMatchObject({ amountMinor: 0, excludesDemo: true, demoPaymentCount: 1 });
    expect(res.body.data.totals.activations).toBeGreaterThanOrEqual(1);
  });

  it('forbids moderators from monetization admin routes', async () => {
    const mod = await createStaff('MODERATOR');
    expect((await request(app).get('/api/v1/admin/subscriptions/stats').set(bearer(mod.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/payments').set(bearer(mod.token))).status).toBe(403);
  });
});
