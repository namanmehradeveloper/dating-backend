// One member's response (LIKE, PASS or SUPER_LIKE) to another member. A member can respond
// to someone only once, enforced by the unique userId + targetUserId index.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const SWIPE_ACTIONS = ['LIKE', 'PASS', 'SUPER_LIKE'];
export const LIKE_ACTIONS = ['LIKE', 'SUPER_LIKE'];

const swipeSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('swp'),
    userId: { type: String, required: true },
    targetUserId: { type: String, required: true },
    action: { type: String, enum: SWIPE_ACTIONS, required: true },
    matchId: String,
  },
  { timestamps: true },
);

swipeSchema.index({ userId: 1, targetUserId: 1 }, { unique: true });
swipeSchema.index({ targetUserId: 1, action: 1, createdAt: -1 });
swipeSchema.index({ userId: 1, createdAt: -1 });

export const Swipe = mongoose.model('Swipe', swipeSchema);
