// A notification sent by staff from the admin panel, kept as history. Each recipient also gets
// a Notification inbox entry linked by campaignId.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const CAMPAIGN_AUDIENCES = ['ALL_USERS', 'VERIFIED_USERS', 'PREMIUM_USERS', 'FREE_USERS', 'SINGLE_USER'];
export const CAMPAIGN_TYPES = ['ANNOUNCEMENT', 'PROMOTION'];

const notificationCampaignSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ncp'),
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: { type: String, enum: CAMPAIGN_TYPES, required: true },
    audience: { type: String, enum: CAMPAIGN_AUDIENCES, required: true },
    targetUserId: String,
    createdBy: { type: String, required: true },
    recipientCount: { type: Number, default: 0 },
    pushStatus: { type: String, enum: ['SENT', 'FEATURE_NOT_CONFIGURED'], required: true },
  },
  { timestamps: true },
);

notificationCampaignSchema.index({ createdAt: -1 });

export const NotificationCampaign = mongoose.model('NotificationCampaign', notificationCampaignSchema);
