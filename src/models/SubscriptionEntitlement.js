// A member's premium entitlement. It is the only source of truth for premium features and is
// only ever written by server-side store verification, never from a client "premium" flag.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const SUBSCRIPTION_TIERS = ['FREE', 'PLUS'];
export const STORE_PLATFORMS = ['IOS', 'ANDROID'];

const subscriptionEntitlementSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ent'),
    userId: { type: String, required: true },
    tier: { type: String, enum: SUBSCRIPTION_TIERS, default: 'FREE' },
    isActive: { type: Boolean, default: false },
    productId: String,
    platform: { type: String, enum: STORE_PLATFORMS },
    expiresAt: Date,
    willRenew: { type: Boolean, default: false },
    // Store transaction id, unique so a purchase cannot be linked to two accounts.
    originalTransactionId: String,
  },
  { timestamps: true },
);

subscriptionEntitlementSchema.index({ userId: 1 }, { unique: true });
subscriptionEntitlementSchema.index(
  { originalTransactionId: 1 },
  { unique: true, partialFilterExpression: { originalTransactionId: { $type: 'string' } } },
);
subscriptionEntitlementSchema.index({ updatedAt: -1 });

export const SubscriptionEntitlement = mongoose.model('SubscriptionEntitlement', subscriptionEntitlementSchema);
