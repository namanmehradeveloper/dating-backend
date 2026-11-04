// Read-only subscription overview for admins. Entitlements change only through verified store
// events, never from the admin panel.

import { Profile } from '../../models/Profile.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { presentEntitlement } from '../subscription.service.js';
import { loadUserCards } from './adminPresenter.js';

const STORE_VERIFICATION = { configured: false, status: 'FEATURE_NOT_CONFIGURED' };

// MongoDB filter for entitlements that are (or are not) currently active.
function activeFilter(isActive) {
  const now = new Date();
  if (isActive) return { isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  return { $or: [{ isActive: false }, { expiresAt: { $lte: now } }] };
}

// Shapes an entitlement row with the store product details admins need.
function presentAdminEntitlement(entitlement, cardFor) {
  return {
    userId: entitlement.userId,
    user: cardFor(entitlement.userId),
    ...presentEntitlement(entitlement),
    productId: entitlement.productId ?? null,
    updatedAt: entitlement.updatedAt,
  };
}

// GET /admin/subscriptions — every stored entitlement, newest first.
export async function listSubscriptions({ tier, isActive, q }, { limit, cursor }) {
  const conditions = [getAfterCursorFilter(cursor)];
  if (tier) conditions.push({ tier });
  if (isActive !== undefined) conditions.push(activeFilter(isActive));
  if (q) {
    if (q.startsWith('usr_')) {
      conditions.push({ userId: q });
    } else {
      const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const [users, profiles] = await Promise.all([
        User.find({ email: pattern }).select('_id').limit(50).lean(),
        Profile.find({ displayName: pattern }).select('userId').limit(50).lean(),
      ]);
      const ids = [...new Set([...users.map((user) => user._id), ...profiles.map((profile) => profile.userId)])];
      conditions.push({ userId: { $in: ids.length ? ids : ['__none__'] } });
    }
  }

  const docs = await SubscriptionEntitlement.find({ $and: conditions }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((entitlement) => entitlement.userId));
  return { items: page.items.map((entitlement) => presentAdminEntitlement(entitlement, cardFor)), nextCursor: page.nextCursor };
}

// GET /admin/subscriptions/:userId — one member's entitlement (FREE when they never subscribed).
export async function getSubscription(userId) {
  if (!(await User.exists({ _id: userId }))) throw ApiError.notFound();
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  const cardFor = await loadUserCards([userId]);
  return {
    user: cardFor(userId),
    entitlement: {
      ...presentEntitlement(entitlement),
      productId: entitlement?.productId ?? null,
      updatedAt: entitlement?.updatedAt ?? null,
    },
    storeVerification: STORE_VERIFICATION,
  };
}
