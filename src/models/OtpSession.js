// The current sign-in code for one phone number: when it was requested, when it expires,
// failed attempts and whether it was used. One session per phone; a new request replaces it.

import mongoose from 'mongoose';

export const OTP_STATUSES = ['ACTIVE', 'USED', 'LOCKED'];

const otpSessionSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true },
    codeHash: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    failedAttempts: { type: Number, default: 0 },
    usedAt: Date,
    status: { type: String, enum: OTP_STATUSES, default: 'ACTIVE' },
    // Removed automatically a day after expiry; the record is only needed while it can be used.
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

otpSessionSchema.index({ phoneNumber: 1 }, { unique: true });
otpSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const OtpSession = mongoose.model('OtpSession', otpSessionSchema);
