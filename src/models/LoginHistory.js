import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

const loginHistorySchema = new mongoose.Schema(
  {
    _id: prefixedIdField('lgh'),
    userId: { type: String, required: true },
    ipAddress: String,
    country: String,
    state: String,
    city: String,
    deviceName: { type: String, required: true },
    deviceType: { type: String, enum: ['MOBILE', 'DESKTOP', 'TABLET'], required: true },
    browser: { type: String, required: true },
    operatingSystem: { type: String, required: true },
    loginAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

loginHistorySchema.index({ userId: 1, loginAt: -1 });
loginHistorySchema.index({ loginAt: -1 });

export const LoginHistory = mongoose.model('LoginHistory', loginHistorySchema);
