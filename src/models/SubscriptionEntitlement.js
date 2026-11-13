// A member's premium entitlement. It is the only source of truth for premium features and is
// only ever written by server-side payment verification, never from a client "premium" flag.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const SUBSCRIPTION_TIERS = ['FREE', 'PLUS'];
export const STORE_PLATFORMS = ['IOS', 'ANDROID', 'WEB'];
export const ENTITLEMENT_PROVIDERS = ['demo', 'razorpay', 'apple', 'google'];
export const ENTITLEMENT_ENVIRONMENTS = ['demo', 'test', 'live'];

const subscriptionEntitlementSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ent'),
    userId: { type: String, required: true },
    tier: { type: String, enum: SUBSCRIPTION_TIERS, default: 'FREE' },
    isActive: { type: Boolean, default: false },
    productId: String,
    platform: { type: String, enum: STORE_PLATFORMS },
    provider: { type: String, enum: ENTITLEMENT_PROVIDERS },
    environment: { type: String, enum: ENTITLEMENT_ENVIRONMENTS },
    expiresAt: Date,
    willRenew: { type: Boolean, default: false },
    // Store / payment transaction id, unique so a purchase cannot be linked to two accounts.
    originalTransactionId: String,
    cancelledAt: Date,
  },
  { timestamps: true },
);

subscriptionEntitlementSchema.index({ userId: 1 }, { unique: true });
subscriptionEntitlementSchema.index(
  { originalTransactionId: 1 },
  { unique: true, partialFilterExpression: { originalTransactionId: { $type: 'string' } } },
);
subscriptionEntitlementSchema.index({ isActive: 1, expiresAt: 1 });
subscriptionEntitlementSchema.index({ updatedAt: -1 });

export const SubscriptionEntitlement = mongoose.model('SubscriptionEntitlement', subscriptionEntitlementSchema);
