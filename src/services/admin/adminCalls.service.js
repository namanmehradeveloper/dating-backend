// Admin call ops: provider status, volume stats, and call metadata.
// Never exposes Agora tokens, media streams, or raw audio/video.

import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { Call, ACTIVE_CALL_STATUSES, CALL_STATUSES, CALL_TYPES } from '../../models/Call.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { ApiError } from '../../utils/ApiError.js';
import { isValidId } from '../../validators/common.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';
import { loadUserCards, resolveMemberIdsByQuery } from './adminPresenter.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export { CALL_STATUSES, CALL_TYPES };

// GET /admin/calls/status
export function getCallsStatus() {
  return {
    configured: env.agora.enabled,
    reason: env.agora.enabled ? null : 'Agora voice/video calling credentials are not configured.',
  };
}

function durationSeconds(call) {
  if (!call.acceptedAt || !call.endedAt) return null;
  const ms = new Date(call.endedAt).getTime() - new Date(call.acceptedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 1000);
}

function presentCall(call, cardFor) {
  return {
    id: String(call._id),
    conversationId: call.conversationId,
    type: call.type,
    status: call.status,
    caller: cardFor(call.callerId),
    callee: cardFor(call.calleeId),
    channelName: call.channelName,
    createdAt: call.createdAt,
    ringExpiresAt: call.ringExpiresAt,
    acceptedAt: call.acceptedAt ?? null,
    endedAt: call.endedAt ?? null,
    durationSeconds: durationSeconds(call),
  };
}

async function resolveCallSearch(q) {
  if (!q) return {};
  if (mongoose.isValidObjectId(q)) return { _id: q };
  if (isValidId(q) && q.startsWith('cnv_')) return { conversationId: q };
  const userIds = await resolveMemberIdsByQuery(q);
  if (userIds.length === 0) return { empty: true };
  return { $or: [{ callerId: { $in: userIds } }, { calleeId: { $in: userIds } }] };
}

// GET /admin/calls/stats?days=
export async function getCallsStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);
  const match = { createdAt: { $gte: since } };

  const [totals, byStatus, byType, activeNow, answeredWithDuration] = await Promise.all([
    Call.countDocuments(match),
    Call.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Call.aggregate([{ $match: match }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    Call.countDocuments({ status: { $in: ACTIVE_CALL_STATUSES } }),
    Call.aggregate([
      {
        $match: {
          ...match,
          status: 'ENDED',
          acceptedAt: { $ne: null },
          endedAt: { $ne: null },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalMs: { $sum: { $subtract: ['$endedAt', '$acceptedAt'] } },
        },
      },
    ]),
  ]);

  const statusCounts = Object.fromEntries(CALL_STATUSES.map((status) => [status, 0]));
  for (const row of byStatus) {
    if (row._id in statusCounts) statusCounts[row._id] = row.count;
  }

  const typeCounts = Object.fromEntries(CALL_TYPES.map((type) => [type, 0]));
  for (const row of byType) {
    if (row._id in typeCounts) typeCounts[row._id] = row.count;
  }

  const answered = answeredWithDuration[0];
  const avgDurationSeconds =
    answered?.count > 0 ? Math.round(answered.totalMs / answered.count / 1000) : null;

  return {
    days: range,
    configured: env.agora.enabled,
    total: totals,
    activeNow,
    audio: typeCounts.AUDIO,
    video: typeCounts.VIDEO,
    byStatus: statusCounts,
    answered: statusCounts.ACCEPTED + statusCounts.ENDED,
    missed: statusCounts.MISSED,
    rejected: statusCounts.REJECTED,
    cancelled: statusCounts.CANCELLED,
    busy: statusCounts.BUSY,
    avgDurationSeconds,
  };
}

// GET /admin/calls?type=&status=&q=
export async function listCalls(filters, { limit, cursor }) {
  const query = {};
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;

  if (filters.q) {
    const resolved = await resolveCallSearch(filters.q);
    if (resolved.empty) return { items: [], nextCursor: null };
    Object.assign(query, resolved);
  }

  const docs = await Call.find(mergeFilters(query, getAfterCursorFilter(cursor, 'createdAt')))
    .sort(getPageSort('createdAt'))
    .limit(limit + 1)
    .lean();

  const page = buildPage(docs, limit, 'createdAt');
  const cardFor = await loadUserCards(page.items.flatMap((row) => [row.callerId, row.calleeId]));
  return {
    items: page.items.map((call) => presentCall(call, cardFor)),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/calls/:callId
export async function getCall(callId) {
  if (!mongoose.isValidObjectId(callId)) throw ApiError.notFound();
  const call = await Call.findById(callId).lean();
  if (!call) throw ApiError.notFound();
  const cardFor = await loadUserCards([call.callerId, call.calleeId]);
  return presentCall(call, cardFor);
}
