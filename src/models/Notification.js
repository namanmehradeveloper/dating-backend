// One entry in a member's notification inbox. `data` only holds safe ids for deep links,
// never message text or location.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const NOTIFICATION_TYPES = ['NEW_MATCH', 'NEW_MESSAGE', 'NEW_LIKE', 'VERIFICATION_RESULT', 'SYSTEM'];

const notificationSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ntf'),
    userId: { type: String, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Map, of: String, default: () => ({}) },
    campaignId: String,
    readAt: Date,
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
