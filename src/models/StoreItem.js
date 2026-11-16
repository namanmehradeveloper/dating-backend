// Virtual goods catalogue: coin packs (money → coins), emoji packs, and gifts.

import mongoose from 'mongoose';

export const STORE_ITEM_KINDS = ['COIN_PACK', 'EMOJI_PACK', 'GIFT'];

const storeItemSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: STORE_ITEM_KINDS, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    // Display glyph when there is no hosted artwork (gifts / packs).
    emoji: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    // EMOJI_PACK only — unlocked glyphs the owner may send in chat.
    emojis: { type: [String], default: [] },
    // Cost in coins to buy this pack/gift from the wallet (not used for COIN_PACK).
    priceCoins: { type: Number, default: 0, min: 0 },
    // COIN_PACK only — real/demo money charge and coins credited on success.
    priceMoneyMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
    coinAmount: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

storeItemSchema.index({ kind: 1, isActive: 1, sortOrder: 1 });

export const StoreItem = mongoose.model('StoreItem', storeItemSchema);
