// A member's selfie verification request, reviewed by moderators in the admin panel.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const VERIFICATION_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

const verificationRequestSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('ver'),
    userId: { type: String, required: true },
    selfieMediaId: { type: String, required: true },
    status: { type: String, enum: VERIFICATION_REQUEST_STATUSES, default: 'PENDING' },
    reason: String,
    reviewedBy: String,
    reviewedAt: Date,
  },
  { timestamps: true },
);

verificationRequestSchema.index({ status: 1, createdAt: -1 });
verificationRequestSchema.index({ userId: 1, createdAt: -1 });

export const VerificationRequest = mongoose.model('VerificationRequest', verificationRequestSchema);
