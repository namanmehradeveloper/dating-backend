// Effective paywall plans = catalog defaults merged with optional AppSetting overrides.
// Admins may change display fields and amountMinor; product ids and periods stay fixed.

import { SUBSCRIPTION_PRODUCTS } from '../config/catalog.js';
import { AppSetting } from '../models/AppSetting.js';
import { ApiError } from '../utils/ApiError.js';
import { recordAudit } from './audit.service.js';

const OVERRIDES_KEY = 'subscriptionProductOverrides';
const ALLOWED_OVERRIDE_FIELDS = ['title', 'description', 'priceLabel', 'amountMinor'];

export async function getProductOverrides() {
  const stored = await AppSetting.findOne({ key: OVERRIDES_KEY }).lean();
  return stored?.value && typeof stored.value === 'object' ? stored.value : {};
}

function mergeProduct(base, override = {}) {
  const amountMinor =
    Number.isInteger(override.amountMinor) && override.amountMinor > 0 ? override.amountMinor : base.amountMinor;
  return {
    ...base,
    title: typeof override.title === 'string' && override.title.trim() ? override.title.trim() : base.title,
    description:
      typeof override.description === 'string' && override.description.trim()
        ? override.description.trim()
        : base.description,
    priceLabel:
      typeof override.priceLabel === 'string' && override.priceLabel.trim()
        ? override.priceLabel.trim()
        : base.priceLabel,
    amountMinor,
    isOverridden: ALLOWED_OVERRIDE_FIELDS.some((field) => override[field] !== undefined && override[field] !== null),
  };
}

export async function getEffectiveProducts() {
  const overrides = await getProductOverrides();
  return SUBSCRIPTION_PRODUCTS.map((product) => mergeProduct(product, overrides[product.id]));
}

export async function getEffectiveProduct(productId) {
  const base = SUBSCRIPTION_PRODUCTS.find((product) => product.id === productId);
  if (!base) return null;
  const overrides = await getProductOverrides();
  return mergeProduct(base, overrides[productId]);
}

export async function listPlansForAdmin() {
  const products = await getEffectiveProducts();
  return {
    items: products.map((product) => ({
      id: product.id,
      tier: product.tier,
      title: product.title,
      description: product.description,
      priceLabel: product.priceLabel,
      period: product.period,
      amountMinor: product.amountMinor,
      currency: product.currency,
      isOverridden: Boolean(product.isOverridden),
      defaults: SUBSCRIPTION_PRODUCTS.find((row) => row.id === product.id),
    })),
  };
}

export async function updatePlan(actor, productId, changes) {
  const base = SUBSCRIPTION_PRODUCTS.find((product) => product.id === productId);
  if (!base) throw ApiError.notFound('Plan not found.');

  const overrides = { ...(await getProductOverrides()) };
  const current = { ...(overrides[productId] || {}) };
  const next = { ...current };

  if (changes.title !== undefined) next.title = String(changes.title).trim();
  if (changes.description !== undefined) next.description = String(changes.description).trim();
  if (changes.priceLabel !== undefined) next.priceLabel = String(changes.priceLabel).trim();
  if (changes.amountMinor !== undefined) next.amountMinor = changes.amountMinor;
  if (changes.reset) {
    delete overrides[productId];
  } else {
    overrides[productId] = next;
  }

  await AppSetting.findOneAndUpdate(
    { key: OVERRIDES_KEY },
    { $set: { value: overrides, updatedBy: actor.id } },
    { upsert: true },
  );

  await recordAudit(actor, {
    action: changes.reset ? 'SUBSCRIPTION_PLAN_RESET' : 'SUBSCRIPTION_PLAN_UPDATE',
    targetType: 'SUBSCRIPTION_PLAN',
    targetId: productId,
    metadata: { changes },
  });

  return listPlansForAdmin().then((page) => page.items.find((item) => item.id === productId));
}
