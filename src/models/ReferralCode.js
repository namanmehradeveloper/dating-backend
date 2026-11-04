// Referral codes owned by members. Reward fulfilment is admin-configured metadata only.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

const referralCodeSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ref'),
    code: { type: String, required: true, uppercase: true, trim: true },
    ownerUserId: { type: String, required: true },
    inviteCount: { type: Number, default: 0 },
    conversionCount: { type: Number, default: 0 },
    rewardConfig: {
      inviterReward: { type: String, default: '' },
      inviteeReward: { type: String, default: '' },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

referralCodeSchema.index({ code: 1 }, { unique: true });
referralCodeSchema.index({ ownerUserId: 1 });
referralCodeSchema.index({ isActive: 1, createdAt: -1 });

export const ReferralCode = mongoose.model('ReferralCode', referralCodeSchema);
