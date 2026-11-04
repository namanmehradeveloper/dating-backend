// Selfie verification review. Moderators compare the selfie (served through a signed URL) with the
// profile photos, then approve or reject; the member's verification status follows the decision.

import { Media } from '../../models/Media.js';
import { Profile } from '../../models/Profile.js';
import { User } from '../../models/User.js';
import { VerificationRequest } from '../../models/VerificationRequest.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildFileUrl } from '../../utils/fileUrls.js';
import { buildPage, encodeCursor, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { notifyUser } from '../notification.service.js';
import { isValidId } from '../../validators/common.js';
import { loadUserCards, resolveMemberIdsByQuery } from './adminPresenter.js';

// Shapes one verification row. `selfieUrl` is optional (list + detail).
function presentVerificationSummary(request, cardFor, selfieUrl = null) {
  return {
    id: request._id,
    status: request.status,
    user: cardFor(request.userId),
    submittedAt: request.createdAt,
    reviewedAt: request.reviewedAt ?? null,
    selfieUrl,
  };
}

// Batch-loads signed selfie URLs for queue rows (skips deleted media).
async function loadSelfieUrls(requests) {
  const ids = requests.map((request) => request.selfieMediaId).filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await Media.find({ _id: { $in: ids } }).select('relativePath status').lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const urls = new Map();
  for (const request of requests) {
    const media = byId.get(String(request.selfieMediaId));
    urls.set(String(request._id), media && media.status !== 'DELETED' ? buildFileUrl(media.relativePath) : null);
  }
  return urls;
}

// Cursor page using an explicit date field (supports aggregation docs that carry `sortAt`).
function buildSortedPage(docs, limit, dateField) {
  if (docs.length <= limit) return { items: docs, nextCursor: null };
  const items = docs.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeCursor(last[dateField], last._id) };
}

// GET /admin/verifications — optionally by status; sort by submitted (createdAt) or reviewedAt.
// reviewedAt may be null for PENDING rows, so that sort uses createdAt as a fallback via $ifNull.
export async function listVerifications({ status, sortBy, sortDir, q }, { limit, cursor }) {
  const query = status ? { status } : {};
  if (q) {
    if (isValidId(q) && q.startsWith('ver_')) query._id = q;
    else {
      const userIds = await resolveMemberIdsByQuery(q);
      if (userIds.length === 0) return { items: [], nextCursor: null };
      query.userId = userIds.length === 1 ? userIds[0] : { $in: userIds };
    }
  }
  const direction = sortDir === 'asc' ? 'asc' : 'desc';

  let page;
  if (sortBy === 'reviewedAt') {
    const order = direction === 'asc' ? 1 : -1;
    const docs = await VerificationRequest.aggregate([
      { $match: query },
      { $addFields: { sortAt: { $ifNull: ['$reviewedAt', '$createdAt'] } } },
      ...(cursor
        ? [
            {
              $match: {
                $or: [
                  { sortAt: { [direction === 'asc' ? '$gt' : '$lt']: cursor.date } },
                  { sortAt: cursor.date, _id: { [direction === 'asc' ? '$gt' : '$lt']: cursor.id } },
                ],
              },
            },
          ]
        : []),
      { $sort: { sortAt: order, _id: order } },
      { $limit: limit + 1 },
    ]);
    page = buildSortedPage(docs, limit, 'sortAt');
  } else {
    const docs = await VerificationRequest.find({ ...query, ...getAfterCursorFilter(cursor, 'createdAt', direction) })
      .sort(getPageSort('createdAt', direction))
      .limit(limit + 1)
      .lean();
    page = buildPage(docs, limit, 'createdAt');
  }

  const [cardFor, selfieUrls] = await Promise.all([
    loadUserCards(page.items.map((request) => request.userId)),
    loadSelfieUrls(page.items),
  ]);
  return {
    items: page.items.map((request) =>
      presentVerificationSummary(request, cardFor, selfieUrls.get(String(request._id)) ?? null),
    ),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/verifications/:id — the selfie, the profile photos to compare, and the decision so far.
export async function getVerification(verificationId) {
  const request = await VerificationRequest.findById(verificationId).lean();
  if (!request) throw ApiError.notFound();

  const [selfie, profile, cardFor] = await Promise.all([
    Media.findById(request.selfieMediaId).select('relativePath status').lean(),
    Profile.findOne({ userId: request.userId }).select('photos').lean(),
    loadUserCards([request.userId, request.reviewedBy]),
  ]);

  const selfieUrl = selfie && selfie.status !== 'DELETED' ? buildFileUrl(selfie.relativePath) : null;

  return {
    ...presentVerificationSummary(request, cardFor, selfieUrl),
    profilePhotos: [...(profile?.photos ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((photo) => ({ id: photo._id, url: buildFileUrl(photo.relativePath) })),
    reason: request.reason ?? null,
    reviewedBy: cardFor(request.reviewedBy),
  };
}

// PATCH /admin/verifications/:id — approve or reject a pending request and tell the member.
export async function reviewVerification(actor, verificationId, { status, reason }) {
  const request = await VerificationRequest.findOneAndUpdate(
    { _id: verificationId, status: 'PENDING' },
    { $set: { status, reason, reviewedBy: actor.id, reviewedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!request) {
    if (!(await VerificationRequest.exists({ _id: verificationId }))) throw ApiError.notFound();
    throw ApiError.conflict('This verification was already reviewed.');
  }

  const isApproved = status === 'APPROVED';
  await User.updateOne({ _id: request.userId }, { $set: { verificationStatus: isApproved ? 'VERIFIED' : 'REJECTED' } });
  await notifyUser(request.userId, {
    type: 'VERIFICATION_RESULT',
    title: isApproved ? 'You are verified' : 'Verification not approved',
    body: isApproved ? 'Your profile now shows the verified badge.' : 'Your selfie could not be verified. You can try again.',
    data: { status },
  });
  await recordAudit(actor, {
    action: 'VERIFICATION_REVIEWED',
    targetType: 'VERIFICATION',
    targetId: verificationId,
    metadata: { userId: request.userId, decision: status, reason: reason ?? null },
  });
  return getVerification(verificationId);
}
