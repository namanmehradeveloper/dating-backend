// Validates store purchase verification and restore requests. Requests are checked even though
// store verification is not configured, so the app gets the same 400s it will get later.

import { SUBSCRIPTION_PRODUCTS } from '../config/catalog.js';
import { DEVICE_PLATFORMS } from '../models/Device.js';
import { checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';

const MAX_PROOF_LENGTH = 20000;
const MAX_RESTORE_PROOFS = 20;

// POST /subscriptions/verify: { platform, productId, transactionProof }.
export function validateVerifyPurchase(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    platform: checkEnum(details, 'platform', body.platform, DEVICE_PLATFORMS),
    productId: checkEnum(details, 'productId', body.productId, SUBSCRIPTION_PRODUCTS.map((product) => product.id)),
    transactionProof: checkText(details, 'transactionProof', body.transactionProof, { max: MAX_PROOF_LENGTH, reason: 'INVALID' }),
  };
  throwIfInvalid(details);
  return input;
}

// POST /subscriptions/restore: { platform, transactionProofs: [1–20 non-empty strings] }.
export function validateRestorePurchases(body) {
  requireObjectBody(body);
  const details = [];
  const platform = checkEnum(details, 'platform', body.platform, DEVICE_PLATFORMS);
  const proofs = body.transactionProofs;
  const areProofsValid =
    Array.isArray(proofs) &&
    proofs.length >= 1 &&
    proofs.length <= MAX_RESTORE_PROOFS &&
    proofs.every((proof) => typeof proof === 'string' && proof.trim() && proof.length <= MAX_PROOF_LENGTH);
  if (!areProofsValid) details.push({ field: 'transactionProofs', reason: 'COUNT_1_20' });
  throwIfInvalid(details);
  return { platform, transactionProofs: proofs };
}
