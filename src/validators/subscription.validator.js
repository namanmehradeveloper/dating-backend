// Validates subscription checkout, verify, restore, cancel and history requests.

import { SUBSCRIPTION_PRODUCTS } from '../config/catalog.js';
import { PAYMENT_PLATFORMS, PAYMENT_PROVIDERS } from '../models/PaymentTransaction.js';
import { checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';
import { parsePagination } from '../utils/pagination.js';

const PRODUCT_IDS = SUBSCRIPTION_PRODUCTS.map((product) => product.id);
const MAX_PROOF_LENGTH = 20000;
const MAX_RESTORE_PROOFS = 20;
const MAX_IDEMPOTENCY_KEY = 120;

// POST /subscriptions/checkout
export function validateCheckout(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    productId: checkEnum(details, 'productId', body.productId, PRODUCT_IDS),
    platform: checkEnum(details, 'platform', body.platform, PAYMENT_PLATFORMS),
    idempotencyKey:
      body.idempotencyKey === undefined || body.idempotencyKey === null || body.idempotencyKey === ''
        ? undefined
        : checkText(details, 'idempotencyKey', body.idempotencyKey, { max: MAX_IDEMPOTENCY_KEY }),
  };
  throwIfInvalid(details);
  return input;
}

// POST /subscriptions/verify — checkout flow (preferred) or legacy store-style body.
export function validateVerifyPurchase(body) {
  requireObjectBody(body);
  const details = [];

  if (body.checkoutId !== undefined && body.checkoutId !== null && body.checkoutId !== '') {
    const checkoutId = checkText(details, 'checkoutId', body.checkoutId, { max: 80 });
    const providerProof =
      body.providerProof === undefined || body.providerProof === null
        ? undefined
        : typeof body.providerProof === 'object' && !Array.isArray(body.providerProof)
          ? body.providerProof
          : null;
    if (body.providerProof != null && providerProof === null) {
      details.push({ field: 'providerProof', reason: 'INVALID' });
    }
    throwIfInvalid(details);
    return { checkoutId, providerProof };
  }

  // Legacy App Store / Play body — still validated so clients get stable 400s.
  const input = {
    platform: checkEnum(details, 'platform', body.platform, ['IOS', 'ANDROID', 'WEB']),
    productId: checkEnum(details, 'productId', body.productId, PRODUCT_IDS),
    transactionProof: checkText(details, 'transactionProof', body.transactionProof, {
      max: MAX_PROOF_LENGTH,
      reason: 'INVALID',
    }),
  };
  throwIfInvalid(details);
  return input;
}

// POST /subscriptions/restore
export function validateRestorePurchases(body) {
  requireObjectBody(body);
  const details = [];
  const platform = checkEnum(details, 'platform', body.platform, PAYMENT_PLATFORMS);

  // Demo restore needs only platform; store providers need proofs.
  const proofs = body.providerProofs ?? body.transactionProofs;
  if (proofs !== undefined) {
    const areProofsValid =
      Array.isArray(proofs) &&
      proofs.length >= 1 &&
      proofs.length <= MAX_RESTORE_PROOFS &&
      proofs.every((proof) => typeof proof === 'string' && proof.trim() && proof.length <= MAX_PROOF_LENGTH);
    if (!areProofsValid) details.push({ field: 'providerProofs', reason: 'COUNT_1_20' });
    throwIfInvalid(details);
    return { platform, providerProofs: proofs, transactionProofs: proofs };
  }

  throwIfInvalid(details);
  return { platform, providerProofs: [], transactionProofs: [] };
}

// POST /subscriptions/cancel
export function validateCancelSubscription(body) {
  if (body === undefined || body === null || Object.keys(body).length === 0) return {};
  requireObjectBody(body);
  const details = [];
  const reason =
    body.reason === undefined || body.reason === null || body.reason === ''
      ? undefined
      : checkText(details, 'reason', body.reason, { max: 200 });
  throwIfInvalid(details);
  return { reason };
}

export function validateHistoryQuery(query) {
  return parsePagination(query);
}

export function validateWebhookProvider(provider) {
  const details = [];
  const name = checkEnum(details, 'provider', provider, PAYMENT_PROVIDERS);
  throwIfInvalid(details);
  return name;
}
