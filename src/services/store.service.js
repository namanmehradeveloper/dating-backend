// Virtual goods store: catalogue, wallet, demo coin-pack checkout, and coin spends for packs/gifts.

import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { CALL_GIFT_SYNC_IDS, DEFAULT_STORE_ITEMS, findStoreItemDefinition } from '../config/catalog.js';
import { env } from '../config/env.js';
import { InventoryItem } from '../models/InventoryItem.js';
import { StoreItem } from '../models/StoreItem.js';
import { StorePurchase } from '../models/StorePurchase.js';
import { Wallet } from '../models/Wallet.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';

const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const DEMO_OUTCOMES = new Set(['SUCCESS', 'FAILURE']);

function resolveGiftCategory(doc) {
  if (doc.kind !== 'GIFT') return undefined;
  if (doc.giftCategory) return doc.giftCategory;
  if ((doc.priceCoins || 0) <= 0) return 'FREE';
  if ((doc.priceCoins || 0) >= 100) return 'PREMIUM';
  return 'POPULAR';
}

export function presentStoreItem(doc) {
  return {
    id: doc._id,
    kind: doc.kind,
    title: doc.title,
    description: doc.description || '',
    emoji: doc.emoji || '',
    imageUrl: doc.imageUrl || '',
    emojis: doc.emojis || [],
    priceCoins: doc.priceCoins || 0,
    giftCategory: resolveGiftCategory(doc),
    priceMoneyMinor: doc.priceMoneyMinor || 0,
    currency: doc.currency || 'INR',
    coinAmount: doc.coinAmount || 0,
    isActive: doc.isActive !== false,
    sortOrder: doc.sortOrder ?? 0,
    priceLabel:
      doc.kind === 'COIN_PACK'
        ? `₹${((doc.priceMoneyMinor || 0) / 100).toLocaleString('en-IN')}`
        : `${doc.priceCoins || 0} coins`,
  };
}

/** Upserts call-gift catalogue rows so existing DBs pick up Heart/Ring/pricing without a wipe. */
async function syncCallGiftCatalog() {
  for (const id of CALL_GIFT_SYNC_IDS) {
    const def = findStoreItemDefinition(id);
    if (!def || def.kind !== 'GIFT') continue;
    await StoreItem.updateOne(
      { _id: id },
      {
        $set: {
          kind: 'GIFT',
          title: def.title,
          description: def.description || '',
          emoji: def.emoji || '',
          imageUrl: def.imageUrl || '',
          priceCoins: def.priceCoins || 0,
          giftCategory: def.giftCategory || resolveGiftCategory(def),
          sortOrder: def.sortOrder ?? 0,
        },
        $setOnInsert: {
          isActive: true,
          emojis: [],
          priceMoneyMinor: 0,
          currency: 'INR',
          coinAmount: 0,
        },
      },
      { upsert: true },
    );
  }
}

export async function ensureDefaultStoreItems() {
  if ((await StoreItem.estimatedDocumentCount()) === 0) {
    try {
      await StoreItem.insertMany(
        DEFAULT_STORE_ITEMS.map((item) => ({ ...item, isActive: true })),
        { ordered: false },
      );
    } catch (error) {
      if (error?.code !== 11000 && !error?.writeErrors) throw error;
    }
  }
  await syncCallGiftCatalog();
}

async function getOrCreateWallet(userId, session) {
  const query = Wallet.findOne({ userId });
  if (session) query.session(session);
  let wallet = await query;
  if (wallet) return wallet;
  try {
    const created = await Wallet.create([{ _id: userId, userId, coinBalance: 0 }], session ? { session } : undefined);
    return created[0];
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const again = Wallet.findOne({ userId });
    if (session) again.session(session);
    return await again;
  }
}

export async function getWallet(userId) {
  await ensureDefaultStoreItems();
  const wallet = await getOrCreateWallet(userId);
  const inventory = await InventoryItem.find({ userId, quantity: { $gt: 0 } }).lean();
  const ownedPackIds = inventory.filter((row) => row.kind === 'EMOJI_PACK').map((row) => row.itemId);
  const giftInventory = inventory
    .filter((row) => row.kind === 'GIFT')
    .map((row) => ({ itemId: row.itemId, quantity: row.quantity }));
  return {
    coinBalance: wallet?.coinBalance ?? 0,
    ownedPackIds,
    giftInventory,
  };
}

export async function listCatalog({ includeInactive = false } = {}) {
  await ensureDefaultStoreItems();
  const query = includeInactive ? {} : { isActive: true };
  const items = await StoreItem.find(query).sort({ sortOrder: 1, _id: 1 }).lean();
  const presented = items.map(presentStoreItem);
  return {
    items: presented,
    coinPacks: presented.filter((item) => item.kind === 'COIN_PACK'),
    emojiPacks: presented.filter((item) => item.kind === 'EMOJI_PACK'),
    gifts: presented.filter((item) => item.kind === 'GIFT'),
  };
}

export async function getActiveItem(itemId) {
  await ensureDefaultStoreItems();
  const item = await StoreItem.findById(itemId).lean();
  if (!item || item.isActive === false) throw ApiError.notFound('This store item is not available.');
  return item;
}

function presentPurchase(doc) {
  return {
    id: doc._id,
    checkoutId: doc.checkoutId,
    itemId: doc.itemId,
    kind: doc.kind,
    provider: doc.provider,
    environment: doc.environment,
    platform: doc.platform,
    amountMinor: doc.amountMinor || 0,
    currency: doc.currency || 'INR',
    coinsDelta: doc.coinsDelta || 0,
    status: doc.status,
    isDemo: doc.provider === 'demo' || doc.environment === 'demo',
    failureReason: doc.failureReason ?? null,
    verifiedAt: doc.verifiedAt ?? null,
    createdAt: doc.createdAt,
  };
}

function assertDemoStorePayments() {
  if (!(env.payments.demoEnabled || env.payments.provider === 'demo')) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', {
      message: 'Demo store payments are not enabled on this server.',
    });
  }
}

// POST /store/checkout — coin packs only (money → coins via demo provider for now).
export async function createCheckout(userId, { itemId, platform }) {
  assertDemoStorePayments();
  const item = await getActiveItem(itemId);
  if (item.kind !== 'COIN_PACK') {
    throw ApiError.validation([{ field: 'itemId', reason: 'MUST_BE_COIN_PACK' }], 'Buy emoji packs and gifts with coins.');
  }

  const checkoutId = `store_${randomUUID().replaceAll('-', '')}`;
  const purchase = await StorePurchase.create({
    userId,
    itemId: item._id,
    kind: item.kind,
    provider: 'demo',
    environment: 'demo',
    platform,
    amountMinor: item.priceMoneyMinor || 0,
    currency: item.currency || 'INR',
    coinsDelta: item.coinAmount || 0,
    status: 'PENDING',
    checkoutId,
    providerRef: `demo_store_${checkoutId}`,
    providerMeta: { demo: true },
  });

  return {
    ...presentPurchase(purchase),
    checkoutExpiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    clientPayload: {
      mode: 'demo',
      simulateOutcomes: ['SUCCESS', 'FAILURE'],
      amountMinor: item.priceMoneyMinor || 0,
      currency: item.currency || 'INR',
      itemId: item._id,
      coinAmount: item.coinAmount || 0,
      instructions: 'Call POST /store/verify with providerProof.outcome SUCCESS or FAILURE.',
    },
  };
}

async function creditCoins(userId, amount, session) {
  if (amount <= 0) return getOrCreateWallet(userId, session);
  const wallet = await getOrCreateWallet(userId, session);
  wallet.coinBalance += amount;
  await wallet.save({ session });
  return wallet;
}

/** Atomic coin debit: only succeeds when balance covers the amount (safe under concurrency). */
async function debitCoins(userId, amount, session) {
  if (amount < 0) {
    throw ApiError.validation([{ field: 'amount', reason: 'INVALID' }]);
  }
  await getOrCreateWallet(userId, session);
  if (amount === 0) {
    const wallet = await getOrCreateWallet(userId, session);
    return wallet;
  }
  const updated = await Wallet.findOneAndUpdate(
    { userId, coinBalance: { $gte: amount } },
    { $inc: { coinBalance: -amount } },
    { returnDocument: 'after', session: session || undefined },
  );
  if (!updated) {
    throw new ApiError('FORBIDDEN', {
      message: 'Not enough coins. Buy a coin pack first.',
      details: [{ field: 'coinBalance', reason: 'INSUFFICIENT_COINS' }],
    });
  }
  return updated;
}

async function recordWalletSpend(userId, item, coinsSpent, session, meta = {}) {
  if (!item || coinsSpent < 0) return null;
  const [purchase] = await StorePurchase.create(
    [
      {
        userId,
        itemId: item._id || item.itemId,
        kind: item.kind || 'GIFT',
        provider: 'wallet',
        environment: env.payments.provider === 'demo' ? 'demo' : 'live',
        platform: 'WEB',
        amountMinor: 0,
        currency: 'INR',
        coinsDelta: -coinsSpent,
        status: 'SUCCEEDED',
        checkoutId: `wallet_${randomUUID().replaceAll('-', '')}`,
        verifiedAt: new Date(),
        creditedAt: new Date(),
        providerMeta: { spend: true, ...meta },
      },
    ],
    { session },
  );
  return purchase;
}

async function addInventory(userId, item, quantity, session) {
  const existing = await InventoryItem.findOne({ userId, itemId: item._id }).session(session);
  if (existing) {
    if (item.kind === 'EMOJI_PACK') {
      existing.quantity = 1;
    } else {
      existing.quantity += quantity;
    }
    await existing.save({ session });
    return existing;
  }
  const [created] = await InventoryItem.create(
    [
      {
        userId,
        itemId: item._id,
        kind: item.kind,
        quantity: item.kind === 'EMOJI_PACK' ? 1 : quantity,
      },
    ],
    { session },
  );
  return created;
}

// POST /store/verify — demo outcome → credit coin pack.
export async function verifyPurchase(userId, { checkoutId, providerProof }) {
  assertDemoStorePayments();
  const purchase = await StorePurchase.findOne({ checkoutId });
  if (!purchase) throw ApiError.notFound('Checkout not found.');
  if (purchase.userId !== userId) throw new ApiError('FORBIDDEN', { message: 'This checkout belongs to another account.' });

  if (purchase.status === 'SUCCEEDED' && purchase.creditedAt) {
    return {
      purchase: presentPurchase(purchase),
      wallet: await getWallet(userId),
      replayed: true,
    };
  }

  if (purchase.status === 'FAILED' || purchase.status === 'CANCELLED') {
    throw ApiError.conflict('This checkout is no longer pending.');
  }

  const outcome = String(providerProof?.outcome || '').toUpperCase();
  if (!DEMO_OUTCOMES.has(outcome)) {
    throw ApiError.validation([{ field: 'providerProof.outcome', reason: 'UNKNOWN_OPTION' }]);
  }

  if (outcome === 'FAILURE') {
    purchase.status = 'FAILED';
    purchase.failureReason = 'DEMO_SIMULATED_FAILURE';
    purchase.verifiedAt = new Date();
    await purchase.save();
    return {
      purchase: presentPurchase(purchase),
      wallet: await getWallet(userId),
      replayed: false,
    };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await creditCoins(userId, purchase.coinsDelta || 0, session);
    purchase.status = 'SUCCEEDED';
    purchase.verifiedAt = new Date();
    purchase.creditedAt = new Date();
    purchase.providerMeta = { ...(purchase.providerMeta || {}), simulated: 'SUCCESS' };
    await purchase.save({ session });
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

  return {
    purchase: presentPurchase(purchase),
    wallet: await getWallet(userId),
    replayed: false,
  };
}

// POST /store/buy-with-coins — unlock emoji pack or add one gift to inventory.
export async function buyWithCoins(userId, { itemId }) {
  const item = await getActiveItem(itemId);
  if (item.kind !== 'EMOJI_PACK' && item.kind !== 'GIFT') {
    throw ApiError.validation([{ field: 'itemId', reason: 'MUST_BE_PACK_OR_GIFT' }], 'Coin packs are bought with checkout.');
  }

  if (item.kind === 'EMOJI_PACK') {
    const owned = await InventoryItem.findOne({ userId, itemId: item._id, quantity: { $gt: 0 } });
    if (owned) throw ApiError.conflict('You already own this emoji pack.');
  }

  const price = item.priceCoins || 0;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await debitCoins(userId, price, session);
    await addInventory(userId, item, 1, session);
    await StorePurchase.create(
      [
        {
          userId,
          itemId: item._id,
          kind: item.kind,
          provider: 'wallet',
          environment: env.payments.provider === 'demo' ? 'demo' : 'live',
          platform: 'WEB',
          amountMinor: 0,
          currency: 'INR',
          coinsDelta: -price,
          status: 'SUCCEEDED',
          checkoutId: `wallet_${randomUUID().replaceAll('-', '')}`,
          verifiedAt: new Date(),
          creditedAt: new Date(),
          providerMeta: { spend: true },
        },
      ],
      { session },
    );
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

  return {
    item: presentStoreItem(item),
    wallet: await getWallet(userId),
  };
}

export async function listPurchaseHistory(userId, { limit, cursor }) {
  const docs = await StorePurchase.find({ userId, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentPurchase), nextCursor: page.nextCursor };
}

// Used by chat/call when sending a gift: prefer inventory unit, else atomic coin debit + ledger.
export async function consumeGiftForSend(userId, itemId, session, meta = {}) {
  await ensureDefaultStoreItems();
  const item = await StoreItem.findById(itemId).session(session);
  if (!item || item.isActive === false || item.kind !== 'GIFT') {
    throw ApiError.notFound('This gift is not available.');
  }

  const price = item.priceCoins || 0;
  let paidWith = 'inventory';
  const inventory = await InventoryItem.findOne({ userId, itemId, quantity: { $gt: 0 } }).session(session);
  if (inventory) {
    inventory.quantity -= 1;
    await inventory.save({ session });
  } else {
    await debitCoins(userId, price, session);
    if (price > 0) {
      await recordWalletSpend(userId, item, price, session, { source: meta.source || 'chat_gift', ...meta });
    }
    paidWith = 'coins';
  }

  return {
    itemId: item._id,
    title: item.title,
    emoji: item.emoji || '',
    imageUrl: item.imageUrl || '',
    priceCoins: price,
    giftCategory: resolveGiftCategory(item),
    paidWith,
  };
}

export async function assertOwnsEmojiPack(userId, packId, emoji, session) {
  await ensureDefaultStoreItems();
  const item = await StoreItem.findById(packId).session(session);
  if (!item || item.isActive === false || item.kind !== 'EMOJI_PACK') {
    throw ApiError.notFound('This emoji pack is not available.');
  }
  if (!Array.isArray(item.emojis) || !item.emojis.includes(emoji)) {
    throw ApiError.validation([{ field: 'paidEmoji.emoji', reason: 'NOT_IN_PACK' }]);
  }
  const owned = await InventoryItem.findOne({ userId, itemId: packId, quantity: { $gt: 0 } }).session(session);
  if (!owned) {
    throw new ApiError('FORBIDDEN', {
      message: 'Buy this emoji pack before sending these emojis.',
      details: [{ field: 'paidEmoji.packId', reason: 'PACK_NOT_OWNED' }],
    });
  }
  return {
    packId: item._id,
    packTitle: item.title,
    emoji,
  };
}

// Admin helpers
export async function adminListItems(filters, { limit, cursor }) {
  await ensureDefaultStoreItems();
  const query = {};
  if (filters.kind) query.kind = filters.kind;
  if (filters.isActive !== undefined) query.isActive = filters.isActive;
  if (filters.q) {
    const re = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ _id: re }, { title: re }, { description: re }];
  }
  const docs = await StoreItem.find({ ...query, ...getAfterCursorFilter(cursor) })
    .sort({ sortOrder: 1, _id: 1 })
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentStoreItem), nextCursor: page.nextCursor };
}

export async function adminUpsertItem(actor, input, { recordAudit }) {
  await ensureDefaultStoreItems();
  const id = String(input.id || input._id || '').trim();
  if (!id) throw ApiError.validation([{ field: 'id', reason: 'REQUIRED' }]);

  const existing = await StoreItem.findById(id);
  const payload = {
    kind: input.kind,
    title: input.title,
    description: input.description ?? '',
    emoji: input.emoji ?? '',
    imageUrl: input.imageUrl ?? '',
    emojis: input.emojis ?? [],
    priceCoins: input.priceCoins ?? 0,
    giftCategory: input.giftCategory || undefined,
    priceMoneyMinor: input.priceMoneyMinor ?? 0,
    currency: input.currency ?? 'INR',
    coinAmount: input.coinAmount ?? 0,
    isActive: input.isActive !== false,
    sortOrder: input.sortOrder ?? 0,
  };

  let doc;
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    doc = existing.toObject();
    await recordAudit(actor, { action: 'STORE_ITEM_UPDATED', targetType: 'STORE_ITEM', targetId: id, metadata: payload });
  } else {
    doc = (await StoreItem.create({ _id: id, ...payload })).toObject();
    await recordAudit(actor, { action: 'STORE_ITEM_CREATED', targetType: 'STORE_ITEM', targetId: id, metadata: payload });
  }
  return presentStoreItem(doc);
}

export async function adminPatchItem(actor, itemId, changes, { recordAudit }) {
  const doc = await StoreItem.findById(itemId);
  if (!doc) throw ApiError.notFound();
  for (const field of [
    'title',
    'description',
    'emoji',
    'imageUrl',
    'emojis',
    'priceCoins',
    'giftCategory',
    'priceMoneyMinor',
    'currency',
    'coinAmount',
    'isActive',
    'sortOrder',
  ]) {
    if (changes[field] !== undefined) doc[field] = changes[field];
  }
  await doc.save();
  await recordAudit(actor, {
    action: 'STORE_ITEM_UPDATED',
    targetType: 'STORE_ITEM',
    targetId: itemId,
    metadata: { changes },
  });
  return presentStoreItem(doc.toObject());
}

export async function adminGetWallet(userId) {
  return getWallet(userId);
}

export async function adminAdjustWallet(actor, userId, { deltaCoins, reason }, { recordAudit }) {
  if (!Number.isInteger(deltaCoins) || deltaCoins === 0) {
    throw ApiError.validation([{ field: 'deltaCoins', reason: 'NON_ZERO_INTEGER' }]);
  }
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (deltaCoins > 0) await creditCoins(userId, deltaCoins, session);
    else await debitCoins(userId, Math.abs(deltaCoins), session);
    await StorePurchase.create(
      [
        {
          userId,
          itemId: 'admin_adjust',
          kind: 'COIN_PACK',
          provider: 'wallet',
          environment: 'demo',
          platform: 'WEB',
          amountMinor: 0,
          currency: 'INR',
          coinsDelta: deltaCoins,
          status: 'SUCCEEDED',
          checkoutId: `admin_${randomUUID().replaceAll('-', '')}`,
          verifiedAt: new Date(),
          creditedAt: new Date(),
          providerMeta: { admin: true, reason: reason || '' },
        },
      ],
      { session },
    );
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
  await recordAudit(actor, {
    action: 'STORE_WALLET_ADJUSTED',
    targetType: 'USER',
    targetId: userId,
    metadata: { deltaCoins, reason },
  });
  return getWallet(userId);
}

export async function adminListPurchases(filters, { limit, cursor }) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.userId) query.userId = filters.userId;
  if (filters.q) {
    const re = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ checkoutId: re }, { itemId: re }, { userId: re }];
  }
  const docs = await StorePurchase.find({ ...query, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentPurchase), nextCursor: page.nextCursor };
}
