// Promo coupon management (ADMIN only). No payment processing.

import { Coupon, COUPON_TIERS, COUPON_TYPES } from '../../models/Coupon.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';

function presentCoupon(doc) {
  return {
    id: doc._id,
    code: doc.code,
    type: doc.type,
    value: doc.value,
    maxRedemptions: doc.maxRedemptions ?? null,
    redemptionCount: doc.redemptionCount ?? 0,
    startsAt: doc.startsAt ?? null,
    endsAt: doc.endsAt ?? null,
    isActive: doc.isActive,
    eligibleTiers: doc.eligibleTiers ?? [],
    createdBy: doc.createdBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// GET /admin/coupons
export async function listCoupons(filters, { limit, cursor }) {
  const query = {};
  if (filters.isActive !== undefined) query.isActive = filters.isActive;
  if (filters.q) query.code = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const docs = await Coupon.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentCoupon), nextCursor: page.nextCursor };
}

// POST /admin/coupons
export async function createCoupon(actor, input) {
  const code = String(input.code).toUpperCase().trim();
  if (await Coupon.exists({ code })) throw ApiError.conflict('A coupon with this code already exists.');

  const doc = await Coupon.create({ ...input, code, createdBy: actor.id });
  await recordAudit(actor, { action: 'COUPON_CREATED', targetType: 'COUPON', targetId: doc._id, metadata: { code } });
  return presentCoupon(doc);
}

// PATCH /admin/coupons/:id — deactivate or adjust fields (no card data).
export async function updateCoupon(actor, id, changes) {
  const doc = await Coupon.findById(id);
  if (!doc) throw ApiError.notFound();

  for (const field of ['type', 'value', 'maxRedemptions', 'redemptionCount', 'startsAt', 'endsAt', 'isActive', 'eligibleTiers']) {
    if (changes[field] !== undefined) doc[field] = changes[field];
  }
  await doc.save();

  await recordAudit(actor, {
    action: 'COUPON_UPDATED',
    targetType: 'COUPON',
    targetId: id,
    metadata: { changes, code: doc.code },
  });
  return presentCoupon(doc.toObject());
}

// GET /admin/coupons/stats
export async function getCouponStats() {
  const [total, active, redemptions] = await Promise.all([
    Coupon.countDocuments(),
    Coupon.countDocuments({ isActive: true }),
    Coupon.aggregate([{ $group: { _id: null, total: { $sum: '$redemptionCount' } } }]),
  ]);
  return { total, active, redemptionCount: redemptions[0]?.total ?? 0 };
}

export { COUPON_TIERS, COUPON_TYPES };
