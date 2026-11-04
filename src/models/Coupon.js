// Promo codes for subscription offers. No payment card data is stored.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const COUPON_TYPES = ['PERCENT', 'FIXED'];
export const COUPON_TIERS = ['FREE', 'PLUS'];

const couponSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('cpn'),
    code: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: COUPON_TYPES, required: true },
    value: { type: Number, required: true },
    maxRedemptions: { type: Number, default: null },
    redemptionCount: { type: Number, default: 0 },
    startsAt: Date,
    endsAt: Date,
    isActive: { type: Boolean, default: true },
    eligibleTiers: { type: [{ type: String, enum: COUPON_TIERS }], default: ['FREE', 'PLUS'] },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ isActive: 1, createdAt: -1 });

export const Coupon = mongoose.model('Coupon', couponSchema);
