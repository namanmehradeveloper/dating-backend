// CMS content CRUD for ADMIN writes; staff may list and read.

import { CmsContent, CMS_STATUSES, CMS_TYPES } from '../../models/CmsContent.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';

function presentCms(doc) {
  return {
    id: doc._id,
    title: doc.title,
    slug: doc.slug,
    type: doc.type,
    status: doc.status,
    body: doc.body ?? '',
    locale: doc.locale ?? 'en',
    publishedAt: doc.publishedAt ?? null,
    updatedBy: doc.updatedBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// GET /admin/cms
export async function listCms(filters, { limit, cursor }) {
  const query = {};
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.locale) query.locale = filters.locale;
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ title: pattern }, { slug: pattern }];
  }

  const docs = await CmsContent.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentCms), nextCursor: page.nextCursor };
}

// GET /admin/cms/:id
export async function getCms(id) {
  const doc = await CmsContent.findById(id).lean();
  if (!doc) throw ApiError.notFound();
  return presentCms(doc);
}

// POST /admin/cms
export async function createCms(actor, input) {
  if (await CmsContent.exists({ slug: input.slug })) {
    throw ApiError.conflict('A CMS entry with this slug already exists.');
  }
  const doc = await CmsContent.create({ ...input, updatedBy: actor.id });
  await recordAudit(actor, { action: 'CMS_CREATED', targetType: 'CMS', targetId: doc._id, metadata: { slug: doc.slug, type: doc.type } });
  return presentCms(doc);
}

// PATCH /admin/cms/:id
export async function updateCms(actor, id, changes) {
  const doc = await CmsContent.findById(id);
  if (!doc) throw ApiError.notFound();

  if (changes.slug && changes.slug !== doc.slug && (await CmsContent.exists({ slug: changes.slug }))) {
    throw ApiError.conflict('A CMS entry with this slug already exists.');
  }

  for (const field of ['title', 'slug', 'type', 'body', 'locale', 'status']) {
    if (changes[field] !== undefined) doc[field] = changes[field];
  }
  if (changes.status === 'PUBLISHED' && !doc.publishedAt) doc.publishedAt = new Date();
  if (changes.status === 'ARCHIVED') {
    /* keep publishedAt for history */
  }
  doc.updatedBy = actor.id;
  await doc.save();

  await recordAudit(actor, {
    action: 'CMS_UPDATED',
    targetType: 'CMS',
    targetId: id,
    metadata: { changes, status: doc.status },
  });
  return presentCms(doc.toObject());
}

// POST /admin/cms/:id/publish | archive helpers via update status
export async function setCmsStatus(actor, id, status) {
  return updateCms(actor, id, { status });
}

export { CMS_STATUSES, CMS_TYPES };
