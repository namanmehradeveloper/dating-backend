// A member's notification settings. Missing records mean every option is on except promotions.

import mongoose from 'mongoose';

const notificationPreferenceSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    newMatches: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    likes: { type: Boolean, default: true },
    promotions: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationPreferenceSchema.index({ userId: 1 }, { unique: true });

export const NotificationPreference = mongoose.model('NotificationPreference', notificationPreferenceSchema);
