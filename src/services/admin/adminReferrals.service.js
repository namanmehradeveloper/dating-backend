// Referral code management (ADMIN only).

import { ReferralCode } from '../../models/ReferralCode.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { loadUserCards, resolveMemberIdsByQuery } from './adminPresenter.js';

function presentReferral(doc, cardFor) {
  return {
    id: doc._id,
    code: doc.code,
    owner: cardFor(doc.ownerUserId),
    inviteCount: doc.inviteCount ?? 0,
    conversionCount: doc.conversionCount ?? 0,
    rewardConfig: doc.rewardConfig ?? {},
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// GET /admin/referrals
export async function listReferrals(filters, { limit, cursor }) {
  const query = {};
  if (filters.ownerUserId) query.ownerUserId = filters.ownerUserId;
  if (filters.isActive !== undefined) query.isActive = filters.isActive;
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const ownerIds = await resolveMemberIdsByQuery(filters.q);
    query.$or = [{ code: pattern }, { _id: filters.q }, { ownerUserId: filters.q }];
    if (ownerIds.length) query.$or.push({ ownerUserId: { $in: ownerIds } });
  }

  const docs = await ReferralCode.find(mergeFilters(query, getAfterCursorFilter(cursor))).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((doc) => doc.ownerUserId));
  return { items: page.items.map((doc) => presentReferral(doc, cardFor)), nextCursor: page.nextCursor };
}

// POST /admin/referrals
export async function createReferral(actor, { code, ownerUserId, rewardConfig }) {
  if (!(await User.exists({ _id: ownerUserId }))) throw ApiError.notFound();
  const normalized = String(code).toUpperCase().trim();
  if (await ReferralCode.exists({ code: normalized })) {
    throw ApiError.conflict('A referral code with this value already exists.');
  }

  const doc = await ReferralCode.create({
    code: normalized,
    ownerUserId,
    rewardConfig: rewardConfig ?? {},
  });
  await recordAudit(actor, {
    action: 'REFERRAL_CREATED',
    targetType: 'REFERRAL',
    targetId: doc._id,
    metadata: { code: normalized, ownerUserId },
  });
  const cardFor = await loadUserCards([ownerUserId]);
  return presentReferral(doc, cardFor);
}

// PATCH /admin/referrals/:id — deactivate or update reward config.
export async function updateReferral(actor, id, changes) {
  const doc = await ReferralCode.findById(id);
  if (!doc) throw ApiError.notFound();

  if (changes.isActive !== undefined) doc.isActive = changes.isActive;
  if (changes.rewardConfig !== undefined) doc.rewardConfig = changes.rewardConfig;
  await doc.save();

  await recordAudit(actor, {
    action: 'REFERRAL_UPDATED',
    targetType: 'REFERRAL',
    targetId: id,
    metadata: { changes, code: doc.code },
  });
  const cardFor = await loadUserCards([doc.ownerUserId]);
  return presentReferral(doc.toObject(), cardFor);
}

// GET /admin/referrals/stats
export async function getReferralStats() {
  const [total, active, invites, conversions] = await Promise.all([
    ReferralCode.countDocuments(),
    ReferralCode.countDocuments({ isActive: true }),
    ReferralCode.aggregate([{ $group: { _id: null, total: { $sum: '$inviteCount' } } }]),
    ReferralCode.aggregate([{ $group: { _id: null, total: { $sum: '$conversionCount' } } }]),
  ]);
  return {
    total,
    active,
    inviteCount: invites[0]?.total ?? 0,
    conversionCount: conversions[0]?.total ?? 0,
  };
}
