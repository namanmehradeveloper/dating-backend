// Provider-independent payment / checkout ledger. Entitlements are applied only after a
// successful server-side verification for the same provider and environment.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const PAYMENT_PROVIDERS = ['demo', 'razorpay'];
export const PAYMENT_ENVIRONMENTS = ['demo', 'test', 'live'];
export const PAYMENT_PLATFORMS = ['IOS', 'ANDROID', 'WEB'];
export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'];

const lifecycleEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false },
);

const paymentTransactionSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('pay'),
    userId: { type: String, required: true },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
    environment: { type: String, enum: PAYMENT_ENVIRONMENTS, required: true },
    productId: { type: String, required: true },
    platform: { type: String, enum: PAYMENT_PLATFORMS, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true, default: 'INR' },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
    // Stable id returned to clients for verify / cancel. Unique across all providers.
    checkoutId: { type: String, required: true },
    // Provider's own reference (order id / payment id). Unique when present per provider.
    providerRef: String,
    idempotencyKey: String,
    originalTransactionId: String,
    period: { type: String, enum: ['MONTHLY', 'YEARLY'], required: true },
    checkoutExpiresAt: Date,
    verifiedAt: Date,
    entitlementAppliedAt: Date,
    failureReason: String,
    lifecycleEvents: { type: [lifecycleEventSchema], default: [] },
    // Sanitized provider metadata only — never store raw secrets or card data.
    providerMeta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

paymentTransactionSchema.index({ checkoutId: 1 }, { unique: true });
paymentTransactionSchema.index({ userId: 1, createdAt: -1 });
paymentTransactionSchema.index({ userId: 1, status: 1, createdAt: -1 });
paymentTransactionSchema.index(
  { provider: 1, providerRef: 1 },
  { unique: true, partialFilterExpression: { providerRef: { $type: 'string' } } },
);
paymentTransactionSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentTransactionSchema.index(
  { originalTransactionId: 1 },
  { unique: true, partialFilterExpression: { originalTransactionId: { $type: 'string' } } },
);

export const PaymentTransaction = mongoose.model('PaymentTransaction', paymentTransactionSchema);
