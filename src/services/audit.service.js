// Audit trail of staff actions. Every admin write calls recordAudit; logs are read-only afterwards.

import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { loadUserCards } from './admin/adminPresenter.js';

// Stores one audit entry. `actor` is req.user (id and role come from the database, not the client).
export async function recordAudit(actor, { action, targetType, targetId, metadata = {} }) {
  await AuditLog.create({ actorId: actor.id, actorRole: actor.role, action, targetType, targetId, metadata });
}

// Member ids an entry refers to besides the actor: a USER target and user ids stored in metadata
// (e.g. the verification's member or the assigned moderator).
function referencedUserIds(log) {
  const ids = Object.values(log.metadata ?? {}).filter((value) => typeof value === 'string' && value.startsWith('usr_'));
  if (log.targetType === 'USER') ids.push(log.targetId);
  return ids;
}

// Shapes an audit entry with the actor's card and cards for every member it refers to.
function presentAuditLog(log, cardFor) {
  const relatedUsers = Object.fromEntries(referencedUserIds(log).map((id) => [id, cardFor(id)]));
  return {
    id: log._id,
    actor: cardFor(log.actorId),
    actorRole: log.actorRole,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId,
    metadata: log.metadata ?? {},
    relatedUsers,
    createdAt: log.createdAt,
  };
}

// Loads user cards for the actors and referenced members of many entries at once.
function loadCardsFor(logs) {
  return loadUserCards(logs.flatMap((log) => [log.actorId, ...referencedUserIds(log)]));
}

// Lists audit entries, newest first, filtered by actor, target, action or target type.
export async function listAuditLogs(filters, { limit, cursor }) {
  const query = {};
  for (const field of ['actorId', 'targetId', 'action', 'targetType']) {
    if (filters[field]) query[field] = filters[field];
  }
  const docs = await AuditLog.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadCardsFor(page.items);
  return { items: page.items.map((log) => presentAuditLog(log, cardFor)), nextCursor: page.nextCursor };
}

// Returns one audit entry.
export async function getAuditLog(auditLogId) {
  const log = await AuditLog.findById(auditLogId).lean();
  if (!log) throw ApiError.notFound();
  return presentAuditLog(log, await loadCardsFor([log]));
}
