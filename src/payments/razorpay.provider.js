// Razorpay adapter placeholder. Implementing checkout, signature verification and webhooks here
// later must not change member API contracts or entitlement logic.

import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { PaymentProvider } from './PaymentProvider.js';

export class RazorpayPaymentProvider extends PaymentProvider {
  get name() {
    return 'razorpay';
  }

  get environment() {
    return env.payments.razorpay.environment;
  }

  get isConfigured() {
    return env.payments.razorpay.enabled;
  }

  assertConfigured() {
    if (!this.isConfigured) {
      throw new ApiError('FEATURE_NOT_CONFIGURED', {
        message: 'Razorpay is not configured yet. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable it.',
      });
    }
    // Keys may be present before the adapter is fully implemented — keep calls honest.
    throw new ApiError('FEATURE_NOT_CONFIGURED', {
      message: 'Razorpay adapter methods are not implemented yet.',
    });
  }

  async createCheckout() {
    this.assertConfigured();
  }

  async verifyPayment() {
    this.assertConfigured();
  }

  async restorePurchase() {
    this.assertConfigured();
  }

  async cancelSubscription() {
    this.assertConfigured();
  }

  async handleWebhook() {
    this.assertConfigured();
  }
}

export const razorpayPaymentProvider = new RazorpayPaymentProvider();
