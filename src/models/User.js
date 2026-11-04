// A Dating Cloud account: sign-in identity (phone and/or email), role, moderation status,
// verification state, staff 2FA and pending deletion. Profile details live in Profile.

import mongoose from 'mongoose';
import { SYSTEM_STAFF_ROLES } from '../config/permissions.catalog.js';
import { prefixedIdField } from '../utils/ids.js';

export const SYSTEM_ROLES = ['USER', ...SYSTEM_STAFF_ROLES];
/** @deprecated Prefer SYSTEM_STAFF_ROLES + custom role slugs; kept for imports. */
export const ROLES = SYSTEM_ROLES;
export const STAFF_ROLES = SYSTEM_STAFF_ROLES;
export const ACCOUNT_STATUSES = ['ACTIVE', 'WARNED', 'SUSPENDED', 'BANNED'];
export const VERIFICATION_STATUSES = ['NONE', 'PENDING', 'VERIFIED', 'REJECTED'];
export const ADMIN_TIER_ROLES = ['SUPER_ADMIN', 'ADMIN'];

const deletionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['NONE', 'SCHEDULED'], default: 'NONE' },
    requestedAt: Date,
    scheduledFor: Date,
    reason: String,
    feedback: String,
  },
  { _id: false },
);

const twoFactorSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    secret: { type: String, select: false },
    verifiedAt: Date,
    backupCodes: { type: [String], select: false, default: [] },
    pendingSecret: { type: String, select: false },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('usr'),
    phoneNumber: { type: String },
    email: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    // System staff slugs, USER, or CUSTOM_* from AdminRole — validated in services (not a fixed enum).
    role: { type: String, default: 'USER', required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'ACTIVE' },
    statusReason: String,
    suspendedUntil: Date,
    onboardingComplete: { type: Boolean, default: false },
    verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'NONE' },
    deletion: { type: deletionSchema, default: () => ({}) },
    lastActiveAt: { type: Date, default: Date.now },
    // Copied into every access token; raising it signs the member out of every device at once.
    sessionVersion: { type: Number, default: 0 },
    twoFactor: { type: twoFactorSchema, default: () => ({}) },
    // Rolling 24h free-rewind usage (premium members ignore this).
    rewindQuota: {
      type: new mongoose.Schema(
        {
          used: { type: Number, default: 0 },
          windowStartedAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

userSchema.index({ phoneNumber: 1 }, { unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ status: 1, createdAt: -1 });
userSchema.index({ role: 1 });

export const User = mongoose.model('User', userSchema);
