// HTTP handlers for subscription products, entitlement and store purchases.

import { ApiResponse } from '../utils/ApiResponse.js';
import * as subscriptionService from '../services/subscription.service.js';
import { validateRestorePurchases, validateVerifyPurchase } from '../validators/subscription.validator.js';

// GET /subscriptions/products — paywall products.
export async function getProducts(req, res) {
  return ApiResponse.ok(res, { items: subscriptionService.listProducts() });
}

// GET /subscriptions/entitlement — the member's current tier.
export async function getEntitlement(req, res) {
  return ApiResponse.ok(res, await subscriptionService.getEntitlement(req.user.id));
}

// POST /subscriptions/verify — validated, then 501 until store verification is configured.
export async function verifyPurchase(req, res) {
  const input = validateVerifyPurchase(req.body);
  return ApiResponse.ok(res, await subscriptionService.verifyPurchase(req.user.id, input));
}

// POST /subscriptions/restore — validated, then 501 until store verification is configured.
export async function restorePurchases(req, res) {
  const input = validateRestorePurchases(req.body);
  return ApiResponse.ok(res, await subscriptionService.restorePurchases(req.user.id, input));
}
