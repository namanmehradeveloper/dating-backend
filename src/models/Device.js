// A phone registered for push notifications (FCM token). A token belongs to one member at a time.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const DEVICE_PLATFORMS = ['IOS', 'ANDROID'];

const deviceSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('dev'),
    userId: { type: String, required: true },
    platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
    pushToken: { type: String, required: true },
    appVersion: String,
    locale: String,
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

deviceSchema.index({ pushToken: 1 }, { unique: true });
deviceSchema.index({ userId: 1 });

export const Device = mongoose.model('Device', deviceSchema);
