// Ledger for store checkouts (coin packs via demo/money; coin spends recorded separately as SPEND).

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const STORE_PURCHASE_PROVIDERS = ['demo', 'razorpay', 'google', 'apple', 'wallet'];
export const STORE_PURCHASE_ENVIRONMENTS = ['demo', 'test', 'live'];
export const STORE_PURCHASE_PLATFORMS = ['IOS', 'ANDROID', 'WEB'];
export const STORE_PURCHASE_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

const storePurchaseSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('spay'),
    userId: { type: String, required: true },
    itemId: { type: String, required: true },
    kind: { type: String, required: true },
    provider: { type: String, enum: STORE_PURCHASE_PROVIDERS, required: true },
    environment: { type: String, enum: STORE_PURCHASE_ENVIRONMENTS, required: true },
    platform: { type: String, enum: STORE_PURCHASE_PLATFORMS, required: true },
    amountMinor: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    coinsDelta: { type: Number, default: 0 },
    status: { type: String, enum: STORE_PURCHASE_STATUSES, default: 'PENDING' },
    checkoutId: { type: String, required: true },
    providerRef: String,
    failureReason: String,
    verifiedAt: Date,
    creditedAt: Date,
    providerMeta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

storePurchaseSchema.index({ checkoutId: 1 }, { unique: true });
storePurchaseSchema.index({ userId: 1, createdAt: -1 });
storePurchaseSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const StorePurchase = mongoose.model('StorePurchase', storePurchaseSchema);
