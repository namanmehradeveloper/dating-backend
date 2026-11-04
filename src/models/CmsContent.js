// Admin-managed CMS content: banners, FAQs, tips, guidelines and static pages.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const CMS_TYPES = ['BANNER', 'FAQ', 'PAGE', 'TIP', 'GUIDELINE'];
export const CMS_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

const cmsContentSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('cms'),
    title: { type: String, required: true },
    slug: { type: String, required: true },
    type: { type: String, enum: CMS_TYPES, required: true },
    status: { type: String, enum: CMS_STATUSES, default: 'DRAFT' },
    body: { type: String, default: '' },
    locale: { type: String, default: 'en' },
    publishedAt: Date,
    updatedBy: String,
  },
  { timestamps: true },
);

cmsContentSchema.index({ slug: 1 }, { unique: true });
cmsContentSchema.index({ type: 1, status: 1, updatedAt: -1 });

export const CmsContent = mongoose.model('CmsContent', cmsContentSchema);
