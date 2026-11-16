// Owned emoji packs (qty 1) and gift stock (qty >= 0) for a member.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';
import { STORE_ITEM_KINDS } from './StoreItem.js';

const inventoryItemSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('inv'),
    userId: { type: String, required: true },
    itemId: { type: String, required: true },
    kind: { type: String, enum: STORE_ITEM_KINDS.filter((k) => k !== 'COIN_PACK'), required: true },
    quantity: { type: Number, default: 1, min: 0 },
  },
  { timestamps: true },
);

inventoryItemSchema.index({ userId: 1, itemId: 1 }, { unique: true });
inventoryItemSchema.index({ userId: 1, kind: 1 });

export const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);
