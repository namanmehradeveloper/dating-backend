// Subscriptions and payments. The server-side entitlement is the only source of truth for
// premium features. All providers share this engine; provider-specific work lives in payments/*.

import { periodDurationMs } from '../config/catalog.js';
import { newId } from '../utils/ids.js';
import { ApiError } from '../utils/ApiError.js';
import { PaymentTransaction } from '../models/PaymentTransaction.js';
import { SubscriptionEntitlement } from '../models/SubscriptionEntitlement.js';
import { getPaymentProvider, getPaymentProviderByName, listPaymentProviders } from '../payments/index.js';
import { emitToUser } from './realtime.service.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { getEffectiveProduct, getEffectiveProducts } from './subscriptionPlans.service.js';

// Returns true while an entitlement is active and not past its expiry date.
function isEntitlementActive(entitlement) {
  if (!entitlement?.isActive) return false;
  return !entitlement.expiresAt || new Date(entitlement.expiresAt) > new Date();
}

// Shapes an entitlement for the API. Members without one are on the free tier.
export function presentEntitlement(entitlement) {
  const isActive = isEntitlementActive(entitlement);
  return {
    tier: isActive ? entitlement.tier : 'FREE',
    isActive,
    expiresAt: entitlement?.expiresAt ?? null,
    willRenew: isActive ? Boolean(entitlement.willRenew) : false,
    platform: entitlement?.platform ?? null,
    provider: entitlement?.provider ?? null,
    environment: entitlement?.environment ?? null,
  };
}

function presentTransaction(doc) {
  return {
    id: doc._id,
    checkoutId: doc.checkoutId,
    provider: doc.provider,
    environment: doc.environment,
    productId: doc.productId,
    platform: doc.platform,
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    status: doc.status,
    period: doc.period,
    failureReason: doc.failureReason ?? null,
    verifiedAt: doc.verifiedAt ?? null,
    createdAt: doc.createdAt,
    // Explicit marker so clients never confuse demo with live billing.
    isDemo: doc.provider === 'demo' || doc.environment === 'demo',
  };
}

function pushLifecycle(transaction, type, meta) {
  transaction.lifecycleEvents.push({ type, at: new Date(), meta });
}

// Returns the member's current entitlement (expired rows present as FREE).
export async function getEntitlement(userId) {
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  return presentEntitlement(entitlement);
}

// Returns true when the member currently has an active paid tier.
export async function isPremium(userId) {
  const entitlement = await SubscriptionEntitlement.findOne({ userId }).lean();
  return isEntitlementActive(entitlement);
}

// Returns the products shown on the paywall (catalog + admin overrides).
export async function listProducts() {
  const products = await getEffectiveProducts();
  return products.map(({ isOverridden, ...product }) => product);
}

export function getBillingStatus() {
  const providers = listPaymentProviders();
  const active = providers.find((item) => item.active);
  return {
    configured: Boolean(active?.configured),
    provider: active?.name ?? null,
    environment: active?.environment ?? null,
    providers,
  };
}

/**
 * Saves an entitlement change that came from a verified payment provider.
 * @param {string} userId
 * @param {object} change Fields to $set on the entitlement document.
 * @param {{ provider: string, environment: string, transactionId?: string }} context
 *   Explicit verification context — demo results can never be written as razorpay.
 */
export async function applyVerifiedEntitlement(userId, change, context = {}) {
  const provider = context.provider ?? change.provider;
  const environment = context.environment ?? change.environment;

  if (!provider || !environment) {
    throw new ApiError('SERVER_ERROR', { message: 'Entitlement updates require a payment provider context.' });
  }
  if (provider === 'demo' && environment !== 'demo') {
    throw new ApiError('FORBIDDEN', { message: 'Demo payments cannot use a non-demo environment.' });
  }
  if (provider === 'razorpay' && environment === 'demo') {
    throw new ApiError('FORBIDDEN', { message: 'Razorpay payments cannot be recorded as demo.' });
  }
  if (provider !== 'demo' && change.provider === 'demo') {
    throw new ApiError('FORBIDDEN', { message: 'Demo transactions cannot be treated as verified provider payments.' });
  }

  const entitlement = await SubscriptionEntitlement.findOneAndUpdate(
    { userId },
    {
      $set: {
        ...change,
        provider,
        environment,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();

  const presented = presentEntitlement(entitlement);
  emitToUser(userId, 'entitlement:updated', {
    tier: presented.tier,
    isActive: presented.isActive,
    provider: presented.provider,
    environment: presented.environment,
  });
  return presented;
}

export async function createCheckout(userId, { productId, platform, idempotencyKey }) {
  const product = await getEffectiveProduct(productId);
  if (!product) throw ApiError.validation([{ field: 'productId', reason: 'UNKNOWN_OPTION' }]);

  if (idempotencyKey) {
    const existing = await PaymentTransaction.findOne({ userId, idempotencyKey }).lean();
    if (existing) {
      return {
        ...presentTransaction(existing),
        clientPayload: existing.providerMeta?.clientPayload ?? { mode: existing.provider },
      };
    }
  }

  const provider = getPaymentProvider();
  const checkoutId = newId('chk');
  const created = await provider.createCheckout({
    userId,
    product,
    platform,
    idempotencyKey,
    checkoutId,
  });

  try {
    const transaction = await PaymentTransaction.create({
      userId,
      provider: provider.name,
      environment: provider.environment,
      productId: product.id,
      platform,
      amountMinor: product.amountMinor,
      currency: product.currency,
      status: 'PENDING',
      checkoutId: created.checkoutId,
      providerRef: created.providerRef,
      idempotencyKey: idempotencyKey || undefined,
      period: product.period,
      checkoutExpiresAt: created.checkoutExpiresAt,
      providerMeta: { ...(created.providerMeta || {}), clientPayload: created.clientPayload },
      lifecycleEvents: [{ type: 'CHECKOUT_CREATED', at: new Date(), meta: { platform } }],
    });

    return {
      ...presentTransaction(transaction),
      clientPayload: created.clientPayload ?? null,
      checkoutExpiresAt: transaction.checkoutExpiresAt ?? null,
    };
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await PaymentTransaction.findOne({ userId, idempotencyKey }).lean();
      if (existing) {
        return {
          ...presentTransaction(existing),
          clientPayload: existing.providerMeta?.clientPayload ?? null,
          checkoutExpiresAt: existing.checkoutExpiresAt ?? null,
        };
      }
    }
    throw error;
  }
}

async function loadOwnedCheckout(userId, checkoutId) {
  const transaction = await PaymentTransaction.findOne({ checkoutId });
  if (!transaction) throw ApiError.notFound('Checkout not found.');
  if (transaction.userId !== userId) throw new ApiError('FORBIDDEN', { message: 'This checkout belongs to another account.' });
  return transaction;
}

export async function verifyPurchase(userId, input) {
  // Legacy store-style body without checkoutId — kept for contract stability; needs a store adapter.
  if (!input.checkoutId) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', {
      message: 'Store purchase verification is not available. Start a checkout session first.',
    });
  }

  const transaction = await loadOwnedCheckout(userId, input.checkoutId);
  if (transaction.provider !== getPaymentProvider().name && transaction.status === 'PENDING') {
    // Pending checkouts must be verified by the same configured provider that created them.
    throw new ApiError('FORBIDDEN', { message: 'This checkout cannot be verified with the active payment provider.' });
  }

  const provider = getPaymentProviderByName(transaction.provider);
  if (!provider.isConfigured) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', { message: `${transaction.provider} is not configured.` });
  }

  // Idempotent success: return current entitlement without re-applying side effects twice.
  if (transaction.status === 'SUCCEEDED' && transaction.entitlementAppliedAt) {
    return {
      payment: presentTransaction(transaction),
      entitlement: await getEntitlement(userId),
      replayed: true,
    };
  }

  const result = await provider.verifyPayment({
    userId,
    transaction,
    providerProof: input.providerProof,
  });

  if (result.status === 'FAILED') {
    transaction.status = 'FAILED';
    transaction.failureReason = result.failureReason || 'PAYMENT_FAILED';
    transaction.providerRef = result.providerRef || transaction.providerRef;
    transaction.originalTransactionId = result.originalTransactionId || transaction.originalTransactionId;
    transaction.providerMeta = { ...(transaction.providerMeta || {}), ...(result.providerMeta || {}) };
    pushLifecycle(transaction, 'PAYMENT_FAILED', { reason: transaction.failureReason });
    await transaction.save();
    return {
      payment: presentTransaction(transaction),
      entitlement: await getEntitlement(userId),
      replayed: false,
    };
  }

  // Guard: never promote a demo verification into a non-demo entitlement provider.
  if (transaction.provider === 'demo' && result.providerMeta && result.providerMeta.asProvider === 'razorpay') {
    throw new ApiError('FORBIDDEN', { message: 'Demo transactions cannot be treated as verified Razorpay payments.' });
  }

  try {
    transaction.status = 'SUCCEEDED';
    transaction.verifiedAt = new Date();
    transaction.providerRef = result.providerRef || transaction.providerRef;
    transaction.originalTransactionId = result.originalTransactionId;
    transaction.failureReason = undefined;
    transaction.providerMeta = { ...(transaction.providerMeta || {}), ...(result.providerMeta || {}) };
    pushLifecycle(transaction, 'PAYMENT_SUCCEEDED', { originalTransactionId: result.originalTransactionId });
    await transaction.save();
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError('CONFLICT', { message: 'This payment was already linked to an account.' });
    }
    throw error;
  }

  const entitlement = await applyVerifiedEntitlement(
    userId,
    {
      tier: 'PLUS',
      isActive: true,
      productId: transaction.productId,
      platform: transaction.platform,
      expiresAt: result.expiresAt,
      willRenew: Boolean(result.willRenew),
      originalTransactionId: result.originalTransactionId,
      cancelledAt: null,
    },
    { provider: transaction.provider, environment: transaction.environment, transactionId: transaction._id },
  );

  transaction.entitlementAppliedAt = new Date();
  pushLifecycle(transaction, 'ENTITLEMENT_APPLIED', { tier: 'PLUS' });
  await transaction.save();

  return { payment: presentTransaction(transaction), entitlement, replayed: false };
}

export async function restorePurchases(userId, input) {
  const provider = getPaymentProvider();

  if (provider.name === 'demo') {
    const latest = await PaymentTransaction.findOne({
      userId,
      provider: 'demo',
      environment: 'demo',
      status: 'SUCCEEDED',
    })
      .sort({ verifiedAt: -1, createdAt: -1 })
      .lean();

    if (!latest) {
      return { restored: false, entitlement: await getEntitlement(userId), payments: [] };
    }

    const entitlement = await applyVerifiedEntitlement(
      userId,
      {
        tier: 'PLUS',
        isActive: true,
        productId: latest.productId,
        platform: latest.platform,
        expiresAt: computeRestoredExpiry(latest),
        willRenew: false,
        originalTransactionId: latest.originalTransactionId,
      },
      { provider: 'demo', environment: 'demo', transactionId: latest._id },
    );

    return {
      restored: true,
      entitlement,
      payments: [presentTransaction(latest)],
    };
  }

  // Non-demo providers implement restore via providerProofs (store receipts / payment ids).
  const results = await provider.restorePurchase({
    userId,
    platform: input.platform,
    providerProofs: input.providerProofs || input.transactionProofs || [],
  });

  const payments = [];
  let entitlement = await getEntitlement(userId);
  for (const result of results) {
    if (result.status !== 'SUCCEEDED') continue;
    entitlement = await applyVerifiedEntitlement(
      userId,
      {
        tier: 'PLUS',
        isActive: true,
        platform: input.platform,
        expiresAt: result.expiresAt,
        willRenew: Boolean(result.willRenew),
        originalTransactionId: result.originalTransactionId,
      },
      { provider: provider.name, environment: provider.environment },
    );
  }

  return { restored: payments.length > 0 || entitlement.isActive, entitlement, payments };
}

function computeRestoredExpiry(latest) {
  // Prefer remaining window from original verification when still in the future.
  const entitlementExpiryGuess =
    latest.verifiedAt && latest.period
      ? new Date(new Date(latest.verifiedAt).getTime() + periodDurationMs(latest.period))
      : null;
  if (entitlementExpiryGuess && entitlementExpiryGuess > new Date()) return entitlementExpiryGuess;
  // Fall back to a fresh period from now so restore is useful in demo.
  return new Date(Date.now() + periodDurationMs(latest.period || 'MONTHLY'));
}

export async function cancelSubscription(userId, { reason } = {}) {
  const entitlement = await SubscriptionEntitlement.findOne({ userId });
  if (!entitlement || !isEntitlementActive(entitlement)) {
    throw ApiError.notFound('No active subscription to cancel.');
  }

  const providerName = entitlement.provider || getPaymentProvider().name;
  const provider = getPaymentProviderByName(providerName);
  if (!provider.isConfigured && providerName !== entitlement.provider) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'Payment provider is not configured.' });
  }

  // Demo (and any configured provider) cancel = stop renewal; access remains until expiresAt.
  if (provider.isConfigured) {
    await provider.cancelSubscription({ userId, entitlement: entitlement.toObject(), reason });
  }

  entitlement.willRenew = false;
  entitlement.cancelledAt = new Date();
  await entitlement.save();

  const presented = presentEntitlement(entitlement);
  emitToUser(userId, 'entitlement:updated', {
    tier: presented.tier,
    isActive: presented.isActive,
    provider: presented.provider,
    environment: presented.environment,
  });
  return presented;
}

export async function listHistory(userId, { limit, cursor }) {
  const filter = { userId, ...getAfterCursorFilter(cursor) };
  const docs = await PaymentTransaction.find(filter).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentTransaction), nextCursor: page.nextCursor };
}

export async function handleProviderWebhook(providerName, { headers, body, rawBody }) {
  const provider = getPaymentProviderByName(providerName);
  if (!provider.isConfigured) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', { message: `${providerName} webhooks are not configured.` });
  }

  const result = await provider.handleWebhook({ headers, body, rawBody });

  // Demo webhooks can flip a pending checkout when signed correctly.
  for (const event of result.events || []) {
    if (!event.checkoutId || !event.status) continue;
    const transaction = await PaymentTransaction.findOne({ checkoutId: event.checkoutId, provider: providerName });
    if (!transaction || transaction.status !== 'PENDING') continue;

    if (event.status === 'SUCCEEDED' || event.status === 'FAILED') {
      const verification = await provider.verifyPayment({
        userId: transaction.userId,
        transaction,
        providerProof: event.status === 'SUCCEEDED' ? { outcome: 'SUCCESS' } : { outcome: 'FAILURE' },
      });

      if (verification.status === 'FAILED') {
        transaction.status = 'FAILED';
        transaction.failureReason = verification.failureReason || 'WEBHOOK_FAILED';
        pushLifecycle(transaction, 'WEBHOOK_FAILED', { type: event.type });
        await transaction.save();
        continue;
      }

      transaction.status = 'SUCCEEDED';
      transaction.verifiedAt = new Date();
      transaction.originalTransactionId = verification.originalTransactionId;
      transaction.providerRef = verification.providerRef || transaction.providerRef;
      pushLifecycle(transaction, 'WEBHOOK_SUCCEEDED', { type: event.type });
      await transaction.save();

      await applyVerifiedEntitlement(
        transaction.userId,
        {
          tier: 'PLUS',
          isActive: true,
          productId: transaction.productId,
          platform: transaction.platform,
          expiresAt: verification.expiresAt,
          willRenew: Boolean(verification.willRenew),
          originalTransactionId: verification.originalTransactionId,
          cancelledAt: null,
        },
        { provider: transaction.provider, environment: transaction.environment, transactionId: transaction._id },
      );
      transaction.entitlementAppliedAt = new Date();
      pushLifecycle(transaction, 'ENTITLEMENT_APPLIED', { via: 'webhook' });
      await transaction.save();
    }
  }

  return { received: true, handled: Boolean(result.handled), provider: providerName };
}

// Marks expired active entitlements as inactive (downgrade). Safe to run repeatedly.
export async function downgradeExpiredSubscriptions(now = new Date()) {
  const result = await SubscriptionEntitlement.updateMany(
    { isActive: true, expiresAt: { $ne: null, $lte: now } },
    { $set: { isActive: false, willRenew: false } },
  );
  return result.modifiedCount ?? result.nModified ?? 0;
}
