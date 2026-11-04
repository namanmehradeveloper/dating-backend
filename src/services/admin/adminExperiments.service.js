// Experiment definitions for ADMIN. No fabricated conversion metrics.

import { Experiment, EXPERIMENT_STATUSES } from '../../models/Experiment.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';

function presentExperiment(doc) {
  return {
    id: doc._id,
    key: doc.key,
    name: doc.name,
    status: doc.status,
    variants: doc.variants ?? [],
    audiencePercent: doc.audiencePercent ?? 100,
    metrics: doc.metrics ?? '',
    startedAt: doc.startedAt ?? null,
    endedAt: doc.endedAt ?? null,
    createdBy: doc.createdBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// GET /admin/experiments
export async function listExperiments(filters, { limit, cursor }) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: pattern }, { key: pattern }];
  }

  const docs = await Experiment.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentExperiment), nextCursor: page.nextCursor };
}

// GET /admin/experiments/:id
export async function getExperiment(id) {
  const doc = await Experiment.findById(id).lean();
  if (!doc) throw ApiError.notFound();
  return presentExperiment(doc);
}

// POST /admin/experiments
export async function createExperiment(actor, input) {
  if (await Experiment.exists({ key: input.key })) {
    throw ApiError.conflict('An experiment with this key already exists.');
  }
  const doc = await Experiment.create({ ...input, createdBy: actor.id });
  await recordAudit(actor, {
    action: 'EXPERIMENT_CREATED',
    targetType: 'EXPERIMENT',
    targetId: doc._id,
    metadata: { key: doc.key },
  });
  return presentExperiment(doc);
}

// PATCH /admin/experiments/:id
export async function updateExperiment(actor, id, changes) {
  const doc = await Experiment.findById(id);
  if (!doc) throw ApiError.notFound();

  for (const field of ['name', 'variants', 'audiencePercent', 'metrics', 'status']) {
    if (changes[field] !== undefined) doc[field] = changes[field];
  }
  if (changes.status === 'RUNNING' && !doc.startedAt) doc.startedAt = new Date();
  if (changes.status === 'COMPLETED') doc.endedAt = new Date();
  await doc.save();

  await recordAudit(actor, {
    action: 'EXPERIMENT_UPDATED',
    targetType: 'EXPERIMENT',
    targetId: id,
    metadata: { changes, key: doc.key, status: doc.status },
  });
  return presentExperiment(doc.toObject());
}

export { EXPERIMENT_STATUSES };
