// Metadata for an uploaded image. The file lives on Cloudinary (or local disk in tests);
// relativePath holds the Cloudinary secure_url or a /uploads/... path. publicId is set for Cloudinary assets.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const MEDIA_PURPOSES = ['PROFILE_PHOTO', 'VERIFICATION_SELFIE', 'CHAT_ATTACHMENT'];
export const MEDIA_STATUSES = ['APPROVED', 'REJECTED', 'DELETED'];

const mediaSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('med'),
    ownerId: { type: String, required: true },
    purpose: { type: String, enum: MEDIA_PURPOSES, required: true },
    status: { type: String, enum: MEDIA_STATUSES, default: 'APPROVED' },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    width: Number,
    height: Number,
    relativePath: { type: String, required: true },
    publicId: { type: String },
    deletedAt: Date,
  },
  { timestamps: true },
);

mediaSchema.index({ ownerId: 1, createdAt: -1 });

export const Media = mongoose.model('Media', mediaSchema);
