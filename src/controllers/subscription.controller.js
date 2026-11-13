// HTTP handlers for subscription products, entitlement, checkout and provider-backed purchases.

import { ApiResponse } from '../utils/ApiResponse.js';
import * as subscriptionService from '../services/subscription.service.js';
import {
  validateCancelSubscription,
  validateCheckout,
  validateHistoryQuery,
  validateRestorePurchases,
  validateVerifyPurchase,
  validateWebhookProvider,
} from '../validators/subscription.validator.js';

// GET /subscriptions/products
export async function getProducts(req, res) {
  return ApiResponse.ok(res, {
    items: await subscriptionService.listProducts(),
    billing: subscriptionService.getBillingStatus(),
  });
}

// GET /subscriptions/entitlement
export async function getEntitlement(req, res) {
  return ApiResponse.ok(res, await subscriptionService.getEntitlement(req.user.id));
}

// POST /subscriptions/checkout
export async function createCheckout(req, res) {
  const input = validateCheckout(req.body);
  return ApiResponse.ok(res, await subscriptionService.createCheckout(req.user.id, input));
}

// POST /subscriptions/verify
export async function verifyPurchase(req, res) {
  const input = validateVerifyPurchase(req.body);
  return ApiResponse.ok(res, await subscriptionService.verifyPurchase(req.user.id, input));
}

// POST /subscriptions/restore
export async function restorePurchases(req, res) {
  const input = validateRestorePurchases(req.body);
  return ApiResponse.ok(res, await subscriptionService.restorePurchases(req.user.id, input));
}

// POST /subscriptions/cancel
export async function cancelSubscription(req, res) {
  const input = validateCancelSubscription(req.body);
  return ApiResponse.ok(res, await subscriptionService.cancelSubscription(req.user.id, input));
}

// GET /subscriptions/history
export async function getHistory(req, res) {
  const pagination = validateHistoryQuery(req.query);
  return ApiResponse.ok(res, await subscriptionService.listHistory(req.user.id, pagination));
}

// POST /subscriptions/webhooks/:provider — public; signature checked inside the provider.
export async function handleWebhook(req, res) {
  const provider = validateWebhookProvider(req.params.provider);
  return ApiResponse.ok(
    res,
    await subscriptionService.handleProviderWebhook(provider, {
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    }),
  );
}
