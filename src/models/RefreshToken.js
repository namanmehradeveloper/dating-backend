// A single-use refresh token, stored only as a hash. Tokens from one sign-in share a familyId,
// so reusing an already-rotated token can revoke the whole family.

import mongoose from 'mongoose';

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    userId: { type: String, required: true },
    familyId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    revokedAt: Date,
    revokedReason: {
      type: String,
      enum: ['LOGOUT', 'REUSE_DETECTED', 'ACCOUNT_STATUS', 'ACCOUNT_DELETED', 'FORCE_LOGOUT', 'ROLE_CHANGED', 'LOGOUT_ALL'],
    },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ userId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
