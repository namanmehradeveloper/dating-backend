// Subscriptions. The server-side entitlement is the only source of truth for premium features.
// App Store / Google Play verification needs store server credentials that are not configured,
// so verify and restore answer FEATURE_NOT_CONFIGURED instead of faking a purchase.

import { SUBSCRIPTION_PRODUCTS } from '../config/catalog.js';
import { SubscriptionEntitlement } from '../models/SubscriptionEntitlement.js';
import { ApiError } from '../utils/ApiError.js';
import { emitToUser } from './realtime.service.js';

// Returns true while an entitlement is active and not past its expiry date.
function isEntitlementActive(entitlement) {
  if (!entitlement?.isActive) return false;
  return !entitlement.expiresAt || new Date(entitlement.expiresAt) > new Date();
}

// Shapes an entitlement for the API. Members without one are on the free tier.
export function presentEntitlement(entitlement) {
  const isActive = isEntitlementActive(entitlement);
  return {
    tier: isActive ? entitlement.tier : 'FREE',
    isActive,
    expiresAt: entitlement?.expiresAt ?? null,
    willRenew: isActive ? Boolean(entitlement.willRenew) : false,
    platform: entitlement?.platform ?? null,
  };
}

// Returns the member's current entitlement.
export async function getEntitlement(userId) {
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  return presentEntitlement(entitlement);
}

// Returns true when the member currently has an active paid tier.
export async function isPremium(userId) {
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  return isEntitlementActive(entitlement);
}

// Returns the products shown on the paywall.
export function listProducts() {
  return SUBSCRIPTION_PRODUCTS;
}

// Store purchase verification. Not configured: no store credentials, and purchases are never trusted from the client.
export async function verifyPurchase() {
  throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'In-app purchases are not available yet.' });
}

// Store purchase restore. Not configured for the same reason as verifyPurchase.
export async function restorePurchases() {
  throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'Restoring purchases is not available yet.' });
}

// Saves an entitlement change that came from a verified store source (for example a future store
// webhook) and tells the member's devices to refetch it with entitlement:updated.
export async function applyVerifiedEntitlement(userId, change) {
  const entitlement = await SubscriptionEntitlement.findOneAndUpdate(
    { userId },
    { $set: change },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  const presented = presentEntitlement(entitlement);
  emitToUser(userId, 'entitlement:updated', { tier: presented.tier, isActive: presented.isActive });
  return presented;
}
