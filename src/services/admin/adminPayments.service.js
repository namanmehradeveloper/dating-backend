// Admin payments status, transaction ledger and volume stats.
// Demo rows are explicitly marked and never included in real revenue totals.

import { env } from '../../config/env.js';
import { PaymentTransaction, PAYMENT_PROVIDERS, PAYMENT_STATUSES } from '../../models/PaymentTransaction.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { listPaymentProviders } from '../../payments/index.js';
import { getSystemInfo } from '../settings.service.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';
import { loadUserCards, resolveMemberIdsByQuery } from './adminPresenter.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isDemoPayment(doc) {
  return doc.provider === 'demo' || doc.environment === 'demo';
}

function presentPayment(doc, cardFor) {
  return {
    id: doc._id,
    checkoutId: doc.checkoutId,
    userId: doc.userId,
    user: cardFor(doc.userId),
    provider: doc.provider,
    environment: doc.environment,
    productId: doc.productId,
    platform: doc.platform,
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    status: doc.status,
    period: doc.period,
    providerRef: doc.providerRef ?? null,
    originalTransactionId: doc.originalTransactionId ?? null,
    failureReason: doc.failureReason ?? null,
    verifiedAt: doc.verifiedAt ?? null,
    createdAt: doc.createdAt,
    isDemo: isDemoPayment(doc),
  };
}

// GET /admin/payments/status
export function getPaymentsStatus() {
  const system = getSystemInfo();
  const providers = listPaymentProviders();
  const active = providers.find((item) => item.active);

  return {
    configured: Boolean(active?.configured),
    storeBillingConfigured: system.storeBillingConfigured,
    provider: active?.name ?? env.payments.provider,
    environment: active?.environment ?? null,
    demoPaymentsEnabled: Boolean(env.payments.demoEnabled),
    demoWebhookConfigured: Boolean(env.payments.demoWebhookSecret),
    razorpayConfigured: Boolean(env.payments.razorpay.enabled),
    razorpayEnvironment: env.payments.razorpay.environment,
    providers,
    reason: active?.configured
      ? `Payments are handled by the ${active.name} provider (${active.environment}).`
      : 'The active payment provider is not configured. Demo requires DEMO_PAYMENTS_ENABLED; Razorpay requires API keys.',
    notes: [
      'DEMO transactions are marked isDemo=true and never count toward revenue.',
      'Payment secrets stay in backend environment variables and are never returned here.',
    ],
  };
}

// GET /admin/payments/stats?days=
export async function getPaymentsStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 30;
  const since = new Date(Date.now() - range * DAY_MS);
  const match = { createdAt: { $gte: since } };

  const [totals, byStatus, byKind, realRevenue, demoVolume] = await Promise.all([
    PaymentTransaction.countDocuments(match),
    PaymentTransaction.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    PaymentTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $cond: [{ $or: [{ $eq: ['$provider', 'demo'] }, { $eq: ['$environment', 'demo'] }] }, 'demo', 'real'],
          },
          count: { $sum: 1 },
        },
      },
    ]),
    PaymentTransaction.aggregate([
      {
        $match: {
          status: 'SUCCEEDED',
          provider: { $ne: 'demo' },
          environment: { $ne: 'demo' },
          verifiedAt: { $gte: since },
        },
      },
      { $group: { _id: '$currency', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    PaymentTransaction.aggregate([
      {
        $match: {
          status: 'SUCCEEDED',
          $or: [{ provider: 'demo' }, { environment: 'demo' }],
          verifiedAt: { $gte: since },
        },
      },
      { $group: { _id: '$currency', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  const statusCounts = Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, 0]));
  for (const row of byStatus) {
    if (row._id in statusCounts) statusCounts[row._id] = row.count;
  }

  const kind = { demo: 0, real: 0 };
  for (const row of byKind) {
    if (row._id in kind) kind[row._id] = row.count;
  }

  return {
    range,
    from: since.toISOString(),
    total: totals,
    byStatus: statusCounts,
    byKind: kind,
    revenue: {
      currency: realRevenue[0]?._id || 'INR',
      amountMinor: realRevenue[0]?.amountMinor || 0,
      paymentCount: realRevenue[0]?.count || 0,
      excludesDemo: true,
    },
    demoVolume: {
      currency: demoVolume[0]?._id || 'INR',
      amountMinor: demoVolume[0]?.amountMinor || 0,
      paymentCount: demoVolume[0]?.count || 0,
      note: 'Simulated only — not revenue.',
    },
  };
}

// GET /admin/payments?status=&kind=demo|real&provider=&q=
export async function listPayments({ status, kind, provider, q, productId }, { limit, cursor }) {
  const conditions = [getAfterCursorFilter(cursor)];
  if (status) conditions.push({ status });
  if (provider) conditions.push({ provider });
  if (productId) conditions.push({ productId });
  if (kind === 'demo') conditions.push({ $or: [{ provider: 'demo' }, { environment: 'demo' }] });
  if (kind === 'real') conditions.push({ provider: { $ne: 'demo' }, environment: { $ne: 'demo' } });

  if (q) {
    if (q.startsWith('pay_') || q.startsWith('chk_')) {
      conditions.push({ $or: [{ _id: q }, { checkoutId: q }, { providerRef: q }, { originalTransactionId: q }] });
    } else if (q.startsWith('usr_')) {
      conditions.push({ userId: q });
    } else {
      const userIds = await resolveMemberIdsByQuery(q);
      if (userIds.length === 0) {
        conditions.push({
          $or: [{ checkoutId: q }, { providerRef: q }, { originalTransactionId: q }, { _id: q }],
        });
      } else {
        conditions.push({
          $or: [
            { userId: { $in: userIds } },
            { checkoutId: q },
            { providerRef: q },
            { originalTransactionId: q },
          ],
        });
      }
    }
  }

  const docs = await PaymentTransaction.find({ $and: conditions }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((payment) => payment.userId));
  return { items: page.items.map((payment) => presentPayment(payment, cardFor)), nextCursor: page.nextCursor };
}

// GET /admin/payments/:paymentId
export async function getPayment(paymentId) {
  const doc = await PaymentTransaction.findById(paymentId).lean();
  if (!doc) throw ApiError.notFound();
  const cardFor = await loadUserCards([doc.userId]);
  return {
    ...presentPayment(doc, cardFor),
    lifecycleEvents: doc.lifecycleEvents || [],
    providerMeta: doc.providerMeta && typeof doc.providerMeta === 'object'
      ? { demo: Boolean(doc.providerMeta.demo), simulated: doc.providerMeta.simulated ?? null }
      : null,
  };
}

// Real (non-demo) revenue helper for the main dashboard.
export async function sumRealRevenueMinor({ since } = {}) {
  const match = { status: 'SUCCEEDED', provider: { $ne: 'demo' }, environment: { $ne: 'demo' } };
  if (since) match.verifiedAt = { $gte: since };
  const rows = await PaymentTransaction.aggregate([
    { $match: match },
    { $group: { _id: '$currency', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
  ]);
  return rows[0] || { _id: 'INR', amountMinor: 0, count: 0 };
}

export { PAYMENT_PROVIDERS, PAYMENT_STATUSES };
