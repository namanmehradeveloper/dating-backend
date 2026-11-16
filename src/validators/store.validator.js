// Validators for /store member endpoints and admin store mutations.

import { isMissing, requireObjectBody, throwIfInvalid, trimmedText } from './common.js';

const PLATFORMS = new Set(['IOS', 'ANDROID', 'WEB']);
const KINDS = new Set(['COIN_PACK', 'EMOJI_PACK', 'GIFT']);

export function validateStoreCheckout(body) {
  requireObjectBody(body);
  const details = [];
  if (typeof body.itemId !== 'string' || !body.itemId.trim()) details.push({ field: 'itemId', reason: 'REQUIRED' });
  if (!PLATFORMS.has(body.platform)) details.push({ field: 'platform', reason: 'UNKNOWN_OPTION' });
  throwIfInvalid(details);
  return { itemId: body.itemId.trim(), platform: body.platform };
}

export function validateStoreVerify(body) {
  requireObjectBody(body);
  const details = [];
  if (typeof body.checkoutId !== 'string' || !body.checkoutId.trim()) {
    details.push({ field: 'checkoutId', reason: 'REQUIRED' });
  }
  if (isMissing(body.providerProof) || typeof body.providerProof !== 'object') {
    details.push({ field: 'providerProof', reason: 'REQUIRED' });
  }
  throwIfInvalid(details);
  return { checkoutId: body.checkoutId.trim(), providerProof: body.providerProof };
}

export function validateBuyWithCoins(body) {
  requireObjectBody(body);
  const details = [];
  if (typeof body.itemId !== 'string' || !body.itemId.trim()) details.push({ field: 'itemId', reason: 'REQUIRED' });
  throwIfInvalid(details);
  return { itemId: body.itemId.trim() };
}

export function validateAdminStoreItemCreate(body) {
  requireObjectBody(body);
  const details = [];
  const id = trimmedText(body.id) || trimmedText(body._id);
  if (!id) details.push({ field: 'id', reason: 'REQUIRED' });
  if (!KINDS.has(body.kind)) details.push({ field: 'kind', reason: 'UNKNOWN_OPTION' });
  if (!trimmedText(body.title)) details.push({ field: 'title', reason: 'REQUIRED' });
  throwIfInvalid(details);
  return {
    id,
    kind: body.kind,
    title: trimmedText(body.title),
    description: trimmedText(body.description) ?? '',
    emoji: trimmedText(body.emoji) ?? '',
    imageUrl: trimmedText(body.imageUrl) ?? '',
    emojis: Array.isArray(body.emojis) ? body.emojis.filter((e) => typeof e === 'string') : [],
    priceCoins: Number.isFinite(body.priceCoins) ? Math.max(0, Math.trunc(body.priceCoins)) : 0,
    priceMoneyMinor: Number.isFinite(body.priceMoneyMinor) ? Math.max(0, Math.trunc(body.priceMoneyMinor)) : 0,
    currency: trimmedText(body.currency) || 'INR',
    coinAmount: Number.isFinite(body.coinAmount) ? Math.max(0, Math.trunc(body.coinAmount)) : 0,
    isActive: body.isActive !== false,
    sortOrder: Number.isFinite(body.sortOrder) ? Math.trunc(body.sortOrder) : 0,
  };
}

export function validateAdminStoreItemPatch(body) {
  requireObjectBody(body);
  const changes = {};
  if (body.title !== undefined) changes.title = trimmedText(body.title) ?? '';
  if (body.description !== undefined) changes.description = trimmedText(body.description) ?? '';
  if (body.emoji !== undefined) changes.emoji = trimmedText(body.emoji) ?? '';
  if (body.imageUrl !== undefined) changes.imageUrl = trimmedText(body.imageUrl) ?? '';
  if (body.emojis !== undefined) {
    changes.emojis = Array.isArray(body.emojis) ? body.emojis.filter((e) => typeof e === 'string') : [];
  }
  if (body.priceCoins !== undefined) changes.priceCoins = Math.max(0, Math.trunc(Number(body.priceCoins) || 0));
  if (body.priceMoneyMinor !== undefined) {
    changes.priceMoneyMinor = Math.max(0, Math.trunc(Number(body.priceMoneyMinor) || 0));
  }
  if (body.currency !== undefined) changes.currency = trimmedText(body.currency) || 'INR';
  if (body.coinAmount !== undefined) changes.coinAmount = Math.max(0, Math.trunc(Number(body.coinAmount) || 0));
  if (body.isActive !== undefined) changes.isActive = Boolean(body.isActive);
  if (body.sortOrder !== undefined) changes.sortOrder = Math.trunc(Number(body.sortOrder) || 0);
  if (Object.keys(changes).length === 0) throwIfInvalid([{ field: 'body', reason: 'EMPTY' }]);
  return changes;
}

export function validateAdminWalletAdjust(body) {
  requireObjectBody(body);
  const details = [];
  if (!Number.isInteger(body.deltaCoins) || body.deltaCoins === 0) {
    details.push({ field: 'deltaCoins', reason: 'NON_ZERO_INTEGER' });
  }
  throwIfInvalid(details);
  return { deltaCoins: body.deltaCoins, reason: trimmedText(body.reason) || '' };
}
