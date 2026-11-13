// Admin subscription overview, dashboard counts, analytics and plan management.
// Entitlements change only through verified payment flows — never from this panel.

import { Profile } from '../../models/Profile.js';
import { PaymentTransaction } from '../../models/PaymentTransaction.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { getBillingStatus, presentEntitlement } from '../subscription.service.js';
import { listPlansForAdmin, updatePlan } from '../subscriptionPlans.service.js';
import { loadUserCards } from './adminPresenter.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBERS = { role: 'USER' };

function storeVerificationStatus() {
  const billing = getBillingStatus();
  return {
    configured: billing.configured,
    status: billing.configured ? 'CONFIGURED' : 'FEATURE_NOT_CONFIGURED',
    provider: billing.provider,
    environment: billing.environment,
  };
}

function isCurrentlyActive(entitlement, now = new Date()) {
  if (!entitlement?.isActive) return false;
  return !entitlement.expiresAt || new Date(entitlement.expiresAt) > now;
}

function lifecycleStatus(entitlement, now = new Date()) {
  if (!entitlement) return 'FREE';
  const active = isCurrentlyActive(entitlement, now);
  if (active && entitlement.cancelledAt) return 'CANCELLED';
  if (active) return 'ACTIVE';
  if (entitlement.expiresAt && new Date(entitlement.expiresAt) <= now) return 'EXPIRED';
  if (entitlement.cancelledAt) return 'CANCELLED';
  return 'INACTIVE';
}

function activeFilter(isActive) {
  const now = new Date();
  if (isActive) return { isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  return { $or: [{ isActive: false }, { expiresAt: { $lte: now } }] };
}

function presentAdminEntitlement(entitlement, cardFor, now = new Date()) {
  const presented = presentEntitlement(entitlement);
  return {
    userId: entitlement.userId,
    user: cardFor(entitlement.userId),
    ...presented,
    productId: entitlement.productId ?? null,
    provider: entitlement.provider ?? presented.provider ?? null,
    environment: entitlement.environment ?? presented.environment ?? null,
    activatedAt: entitlement.createdAt ?? null,
    cancelledAt: entitlement.cancelledAt ?? null,
    lifecycleStatus: lifecycleStatus(entitlement, now),
    isDemo: entitlement.provider === 'demo' || entitlement.environment === 'demo',
    updatedAt: entitlement.updatedAt,
  };
}

// GET /admin/subscriptions/stats
export async function getSubscriptionStats() {
  const now = new Date();
  const [totalMembers, activePlus, expired, cancelled, entitlementDocs] = await Promise.all([
    User.countDocuments(MEMBERS),
    SubscriptionEntitlement.countDocuments({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }),
    SubscriptionEntitlement.countDocuments({
      $or: [{ isActive: false, expiresAt: { $lte: now } }, { expiresAt: { $lte: now } }],
      productId: { $type: 'string' },
    }),
    SubscriptionEntitlement.countDocuments({ cancelledAt: { $ne: null } }),
    SubscriptionEntitlement.countDocuments({}),
  ]);

  // Free = members who are not currently on an active Plus entitlement.
  const free = Math.max(totalMembers - activePlus, 0);

  return {
    totalMembers,
    free,
    activePlus,
    expired,
    cancelled,
    entitlementRecords: entitlementDocs,
    billing: getBillingStatus(),
  };
}

// GET /admin/subscriptions — every stored entitlement, newest first.
export async function listSubscriptions({ tier, isActive, q, provider, lifecycle, environment }, { limit, cursor }) {
  const now = new Date();
  const conditions = [getAfterCursorFilter(cursor)];

  if (tier) conditions.push({ tier });
  if (isActive !== undefined) conditions.push(activeFilter(isActive));
  if (provider) conditions.push({ provider });
  if (environment) conditions.push({ environment });

  if (lifecycle === 'ACTIVE') {
    conditions.push({ isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }], cancelledAt: null });
  } else if (lifecycle === 'CANCELLED') {
    conditions.push({ cancelledAt: { $ne: null } });
  } else if (lifecycle === 'EXPIRED') {
    conditions.push({ expiresAt: { $lte: now } });
  } else if (lifecycle === 'FREE') {
    conditions.push({
      $or: [{ tier: 'FREE' }, { isActive: false, cancelledAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }],
    });
  }

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
  return {
    items: page.items.map((entitlement) => presentAdminEntitlement(entitlement, cardFor, now)),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/subscriptions/:userId
export async function getSubscription(userId) {
  if (!(await User.exists({ _id: userId }))) throw ApiError.notFound();
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  const cardFor = await loadUserCards([userId]);
  const payments = await PaymentTransaction.find({ userId }).sort({ createdAt: -1 }).limit(20).lean();

  return {
    user: cardFor(userId),
    entitlement: entitlement
      ? {
          ...presentAdminEntitlement(entitlement, cardFor),
          productId: entitlement.productId ?? null,
          updatedAt: entitlement.updatedAt ?? null,
          originalTransactionId: entitlement.originalTransactionId ?? null,
        }
      : {
          tier: 'FREE',
          isActive: false,
          expiresAt: null,
          willRenew: false,
          platform: null,
          provider: null,
          environment: null,
          productId: null,
          activatedAt: null,
          cancelledAt: null,
          lifecycleStatus: 'FREE',
          isDemo: false,
          updatedAt: null,
        },
    recentPayments: payments.map((payment) => ({
      id: payment._id,
      checkoutId: payment.checkoutId,
      provider: payment.provider,
      environment: payment.environment,
      productId: payment.productId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.status,
      isDemo: payment.provider === 'demo' || payment.environment === 'demo',
      createdAt: payment.createdAt,
      verifiedAt: payment.verifiedAt ?? null,
    })),
    storeVerification: storeVerificationStatus(),
  };
}

function demoMatch() {
  return { $or: [{ provider: 'demo' }, { environment: 'demo' }] };
}

function realMatch() {
  return { provider: { $ne: 'demo' }, environment: { $ne: 'demo' } };
}

// GET /admin/subscriptions/analytics?days=
export async function getSubscriptionAnalytics({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 30;
  const now = new Date();
  const since = new Date(now.getTime() - range * DAY_MS);
  const prevSince = new Date(since.getTime() - range * DAY_MS);

  const succeeded = { status: 'SUCCEEDED' };
  const realSucceeded = { ...succeeded, ...realMatch() };
  const demoSucceeded = { ...succeeded, ...demoMatch() };

  const [
    totalMembers,
    activePlus,
    newPlusInRange,
    newPlusPrev,
    checkoutsInRange,
    realRevenue,
    demoVolume,
    growthByDay,
  ] = await Promise.all([
    User.countDocuments(MEMBERS),
    SubscriptionEntitlement.countDocuments({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }),
    PaymentTransaction.countDocuments({ ...succeeded, verifiedAt: { $gte: since } }),
    PaymentTransaction.countDocuments({ ...succeeded, verifiedAt: { $gte: prevSince, $lt: since } }),
    PaymentTransaction.countDocuments({ createdAt: { $gte: since } }),
    PaymentTransaction.aggregate([
      { $match: { ...realSucceeded, verifiedAt: { $gte: since } } },
      { $group: { _id: '$currency', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    PaymentTransaction.aggregate([
      { $match: { ...demoSucceeded, verifiedAt: { $gte: since } } },
      { $group: { _id: '$currency', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    PaymentTransaction.aggregate([
      { $match: { ...succeeded, verifiedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$verifiedAt' } },
          activations: { $sum: 1 },
          demoActivations: {
            $sum: { $cond: [{ $or: [{ $eq: ['$provider', 'demo'] }, { $eq: ['$environment', 'demo'] }] }, 1, 0] },
          },
          realActivations: {
            $sum: {
              $cond: [
                {
                  $and: [{ $ne: ['$provider', 'demo'] }, { $ne: ['$environment', 'demo'] }],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Renewals: succeeded payments in range where the user had an earlier succeeded payment.
  const renewalRows = await PaymentTransaction.aggregate([
    { $match: { ...succeeded, verifiedAt: { $gte: since } } },
    { $sort: { verifiedAt: 1 } },
    {
      $lookup: {
        from: PaymentTransaction.collection.name,
        let: { uid: '$userId', verified: '$verifiedAt' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$userId', '$$uid'] },
                  { $eq: ['$status', 'SUCCEEDED'] },
                  { $lt: ['$verifiedAt', '$$verified'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'prior',
      },
    },
    { $match: { 'prior.0': { $exists: true } } },
    {
      $group: {
        _id: null,
        renewals: { $sum: 1 },
        realRenewals: {
          $sum: {
            $cond: [{ $and: [{ $ne: ['$provider', 'demo'] }, { $ne: ['$environment', 'demo'] }] }, 1, 0],
          },
        },
        demoRenewals: {
          $sum: {
            $cond: [{ $or: [{ $eq: ['$provider', 'demo'] }, { $eq: ['$environment', 'demo'] }] }, 1, 0],
          },
        },
      },
    },
  ]);

  const realRevenueRow = realRevenue[0] || { amountMinor: 0, count: 0, _id: 'INR' };
  const demoVolumeRow = demoVolume[0] || { amountMinor: 0, count: 0, _id: 'INR' };
  const renewal = renewalRows[0] || { renewals: 0, realRenewals: 0, demoRenewals: 0 };
  const conversionRate = checkoutsInRange > 0 ? Number(((newPlusInRange / checkoutsInRange) * 100).toFixed(2)) : 0;
  const plusPenetration = totalMembers > 0 ? Number(((activePlus / totalMembers) * 100).toFixed(2)) : 0;

  return {
    range,
    from: since.toISOString(),
    to: now.toISOString(),
    totals: {
      totalMembers,
      activePlus,
      plusPenetration,
      activations: newPlusInRange,
      activationsPrevious: newPlusPrev,
      checkouts: checkoutsInRange,
      conversionRate,
    },
    renewals: {
      total: renewal.renewals,
      real: renewal.realRenewals,
      demo: renewal.demoRenewals,
      // Keep unused query var honest when lookup path is heavy — prefer aggregation result.
      note: 'A renewal is a successful payment after a prior successful payment for the same member.',
    },
    revenue: {
      currency: realRevenueRow._id || 'INR',
      // Demo never counts as revenue.
      amountMinor: realRevenueRow.amountMinor || 0,
      paymentCount: realRevenueRow.count || 0,
      demoVolumeMinor: demoVolumeRow.amountMinor || 0,
      demoPaymentCount: demoVolumeRow.count || 0,
      excludesDemo: true,
    },
    growth: growthByDay.map((row) => ({
      date: row._id,
      activations: row.activations,
      realActivations: row.realActivations,
      demoActivations: row.demoActivations,
    })),
  };
}

export async function listSubscriptionPlans() {
  return listPlansForAdmin();
}

export async function updateSubscriptionPlan(actor, productId, changes) {
  return updatePlan(actor, productId, changes);
}
