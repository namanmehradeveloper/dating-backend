// Moderation queue: lists reports, shows the reported content, and records each status change.
// Closed reports (ACTIONED / DISMISSED) cannot be reopened.

import { Message } from '../../models/Message.js';
import { Profile } from '../../models/Profile.js';
import { Report } from '../../models/Report.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildFileUrl } from '../../utils/fileUrls.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { loadUserCards } from './adminPresenter.js';

const CLOSED_STATUSES = ['ACTIONED', 'DISMISSED'];

// Shapes one report row using preloaded user cards.
function presentReportSummary(report, cardFor) {
  return {
    id: report._id,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: report.reason,
    status: report.status,
    reporter: cardFor(report.reporterId),
    reportedUser: cardFor(report.targetUserId),
    assignedModerator: cardFor(report.assignedModeratorId),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

// Shapes many report rows, loading every user card with one batch.
export async function presentReportSummaries(reports) {
  const cardFor = await loadUserCards(reports.flatMap((report) => [report.reporterId, report.targetUserId, report.assignedModeratorId]));
  return reports.map((report) => presentReportSummary(report, cardFor));
}

// GET /admin/reports — newest first.
export async function listReports(filters, { limit, cursor }) {
  const query = {};
  for (const field of ['status', 'targetType', 'reason']) {
    if (filters[field]) query[field] = filters[field];
  }
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ _id: filters.q }, { targetId: pattern }, { reporterId: filters.q }, { targetUserId: filters.q }];
  }
  const docs = await Report.find(mergeFilters(query, getAfterCursorFilter(cursor))).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  return { items: await presentReportSummaries(page.items), nextCursor: page.nextCursor };
}

// Loads what was reported so a moderator can judge it: the photo, the message text and photo, or the profile.
// Returns null when the content no longer exists.
async function loadReportedContent(report) {
  if (report.targetType === 'MESSAGE') {
    const message = await Message.findById(report.targetId).lean();
    if (!message) return null;
    return {
      text: message.text ?? '',
      photoUrl: message.attachment?.relativePath ? buildFileUrl(message.attachment.relativePath) : null,
      sentAt: message.sentAt,
      conversationId: message.conversationId,
    };
  }
  const profile = await Profile.findOne({ userId: report.targetUserId }).select('displayName bio photos').lean();
  if (!profile) return null;
  if (report.targetType === 'PHOTO') {
    const photo = profile.photos.find((item) => item._id === report.targetId);
    return photo ? { photoUrl: buildFileUrl(photo.relativePath) } : null;
  }
  return {
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    photos: [...profile.photos].sort((a, b) => a.order - b.order).map((photo) => ({ id: photo._id, url: buildFileUrl(photo.relativePath) })),
  };
}

// GET /admin/reports/:reportId — full report with history and the reported content.
export async function getReport(reportId) {
  const report = await Report.findById(reportId).lean();
  if (!report) throw ApiError.notFound();

  const historyActorIds = report.history.map((entry) => entry.actorId);
  const cardFor = await loadUserCards([report.reporterId, report.targetUserId, report.assignedModeratorId, ...historyActorIds]);
  const [content, previousReportsAgainstUser] = await Promise.all([
    loadReportedContent(report),
    Report.countDocuments({ targetUserId: report.targetUserId, _id: { $ne: report._id } }),
  ]);

  return {
    ...presentReportSummary(report, cardFor),
    details: report.details ?? null,
    resolutionNote: report.resolutionNote ?? null,
    resolvedAt: report.resolvedAt ?? null,
    content,
    previousReportsAgainstUser,
    history: report.history.map((entry) => ({ status: entry.status, actor: cardFor(entry.actorId), note: entry.note ?? null, at: entry.at })),
  };
}

// PATCH /admin/reports/:reportId — change status, add a resolution note, or take the report.
export async function updateReport(actor, reportId, { status, resolutionNote, assignToMe }) {
  const report = await Report.findById(reportId);
  if (!report) throw ApiError.notFound();
  if (CLOSED_STATUSES.includes(report.status)) throw ApiError.conflict('This report is already closed.');

  const previousStatus = report.status;
  if (assignToMe || (status === 'IN_REVIEW' && !report.assignedModeratorId)) report.assignedModeratorId = actor.id;
  if (resolutionNote !== undefined) report.resolutionNote = resolutionNote;
  if (status) {
    report.status = status;
    report.history.push({ status, actorId: actor.id, note: resolutionNote, at: new Date() });
    if (CLOSED_STATUSES.includes(status)) report.resolvedAt = new Date();
  }
  await report.save();

  await recordAudit(actor, {
    action: 'REPORT_UPDATED',
    targetType: 'REPORT',
    targetId: reportId,
    metadata: { from: previousStatus, to: report.status, assignedModeratorId: report.assignedModeratorId ?? null, resolutionNote: resolutionNote ?? null },
  });
  return getReport(reportId);
}
