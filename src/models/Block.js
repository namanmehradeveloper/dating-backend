// One member blocking another. Blocks hide both members from each other everywhere.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

const blockSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('blk'),
    blockerId: { type: String, required: true },
    blockedId: { type: String, required: true },
  },
  { timestamps: true },
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });
blockSchema.index({ blockerId: 1, createdAt: -1 });

export const Block = mongoose.model('Block', blockSchema);
