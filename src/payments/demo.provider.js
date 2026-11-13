// Demo payment adapter for local / staging flows. All transactions are marked environment=demo
// and must never be treated as Razorpay (or any live) payments.

import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { periodDurationMs } from '../config/catalog.js';
import { ApiError } from '../utils/ApiError.js';
import { PaymentProvider } from './PaymentProvider.js';

const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const DEMO_OUTCOMES = new Set(['SUCCESS', 'FAILURE']);

function timingSafeEqualText(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class DemoPaymentProvider extends PaymentProvider {
  get name() {
    return 'demo';
  }

  get environment() {
    return 'demo';
  }

  get isConfigured() {
    return env.payments.demoEnabled;
  }

  assertConfigured() {
    if (!this.isConfigured) {
      throw new ApiError('FEATURE_NOT_CONFIGURED', {
        message: 'Demo payments are not enabled on this server.',
      });
    }
  }

  async createCheckout({ product, checkoutId, platform }) {
    this.assertConfigured();
    const providerRef = `demo_order_${checkoutId}`;
    return {
      checkoutId,
      provider: this.name,
      environment: this.environment,
      providerRef,
      checkoutExpiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
      clientPayload: {
        mode: 'demo',
        simulateOutcomes: ['SUCCESS', 'FAILURE'],
        amountMinor: product.amountMinor,
        currency: product.currency,
        productId: product.id,
        platform,
        instructions: 'Call POST /subscriptions/verify with providerProof.outcome SUCCESS or FAILURE.',
      },
      providerMeta: { demo: true },
    };
  }

  async verifyPayment({ transaction, providerProof }) {
    this.assertConfigured();

    if (transaction.provider !== 'demo' || transaction.environment !== 'demo') {
      throw new ApiError('FORBIDDEN', { message: 'This checkout does not belong to the demo provider.' });
    }

    if (transaction.status === 'SUCCEEDED') {
      return {
        status: 'SUCCEEDED',
        providerRef: transaction.providerRef,
        originalTransactionId: transaction.originalTransactionId,
        expiresAt: computeExpiry(transaction.period, transaction.verifiedAt || new Date()),
        willRenew: true,
        providerMeta: { demo: true, replay: true },
      };
    }

    if (transaction.status === 'FAILED' || transaction.status === 'CANCELLED') {
      throw new ApiError('CONFLICT', { message: 'This checkout is no longer pending.' });
    }

    if (transaction.checkoutExpiresAt && new Date(transaction.checkoutExpiresAt) <= new Date()) {
      return {
        status: 'FAILED',
        failureReason: 'CHECKOUT_EXPIRED',
        originalTransactionId: transaction.originalTransactionId || `demo_expired_${transaction.checkoutId}`,
        expiresAt: new Date(0),
        willRenew: false,
        providerMeta: { demo: true },
      };
    }

    const outcome = String(providerProof?.outcome || '').toUpperCase();
    if (!DEMO_OUTCOMES.has(outcome)) {
      throw ApiError.validation([{ field: 'providerProof.outcome', reason: 'UNKNOWN_OPTION' }]);
    }

    if (outcome === 'FAILURE') {
      return {
        status: 'FAILED',
        failureReason: 'DEMO_SIMULATED_FAILURE',
        providerRef: transaction.providerRef,
        originalTransactionId: `demo_fail_${transaction.checkoutId}`,
        expiresAt: new Date(0),
        willRenew: false,
        providerMeta: { demo: true, simulated: 'FAILURE' },
      };
    }

    const originalTransactionId = `demo_txn_${transaction.checkoutId}`;
    const verifiedAt = new Date();
    return {
      status: 'SUCCEEDED',
      providerRef: transaction.providerRef || `demo_pay_${transaction.checkoutId}`,
      originalTransactionId,
      expiresAt: computeExpiry(transaction.period, verifiedAt),
      willRenew: true,
      providerMeta: { demo: true, simulated: 'SUCCESS' },
    };
  }

  async restorePurchase({ userId }) {
    this.assertConfigured();
    // Restore is handled by the shared subscription engine from the payment ledger for demo.
    // Returning an empty list keeps the provider contract; the engine rehydrates from DB.
    void userId;
    return [];
  }

  async cancelSubscription() {
    this.assertConfigured();
    return { willRenew: false, cancelledAt: new Date() };
  }

  async handleWebhook({ headers, body }) {
    this.assertConfigured();
    const secret = env.payments.demoWebhookSecret;
    if (!secret) {
      throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'Demo webhooks are not configured.' });
    }
    const signature = headers['x-demo-signature'] || headers['X-Demo-Signature'];
    if (!timingSafeEqualText(secret, Array.isArray(signature) ? signature[0] : signature)) {
      throw new ApiError('FORBIDDEN', { message: 'Invalid demo webhook signature.' });
    }

    const event = body && typeof body === 'object' ? body : {};
    return {
      handled: true,
      events: [
        {
          type: event.type || 'demo.payment.updated',
          checkoutId: event.checkoutId || null,
          status: event.status || null,
          provider: 'demo',
          environment: 'demo',
        },
      ],
    };
  }
}

function computeExpiry(period, from = new Date()) {
  return new Date(from.getTime() + periodDurationMs(period));
}

export const demoPaymentProvider = new DemoPaymentProvider();
