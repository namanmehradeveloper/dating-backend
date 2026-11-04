// Rule-based fraud / abuse signals. No third-party AI; scans produce scores from local rules.

import { Profile } from '../../models/Profile.js';
import { Report } from '../../models/Report.js';
import { Swipe } from '../../models/Swipe.js';
import { User } from '../../models/User.js';
import { UserRiskSignal, RISK_STATUSES } from '../../models/UserRiskSignal.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { loadUserCards } from './adminPresenter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_SWIPE_VELOCITY = 80;
const MANY_REPORTS = 3;
const MANY_LIKES_NO_PHOTOS = 20;

function presentSignal(doc, cardFor) {
  return {
    id: doc._id,
    user: cardFor(doc.userId),
    signals: doc.signals ?? [],
    totalScore: doc.totalScore ?? 0,
    status: doc.status,
    reviewedBy: cardFor(doc.reviewedBy),
    reviewedAt: doc.reviewedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// GET /admin/fraud/status
export function getFraudProviderStatus() {
  return { configured: false, provider: null, modes: ['RULE_BASED'] };
}

// Runs local rules and upserts an OPEN risk signal for the member.
export async function scanUser(actor, userId) {
  if (!(await User.exists({ _id: userId }))) throw ApiError.notFound();

  const since = new Date(Date.now() - DAY_MS);
  const [swipeCount, reportsAgainst, profile] = await Promise.all([
    Swipe.countDocuments({ userId, createdAt: { $gte: since } }),
    Report.countDocuments({ targetUserId: userId, status: { $in: ['OPEN', 'IN_REVIEW', 'ACTIONED'] } }),
    Profile.findOne({ userId }).select('displayName photos').lean(),
  ]);

  const signals = [];
  if (swipeCount >= HIGH_SWIPE_VELOCITY) {
    signals.push({ code: 'HIGH_SWIPE_VELOCITY', score: 40, detail: `${swipeCount} swipes in last 24h` });
  }
  if (reportsAgainst >= MANY_REPORTS) {
    signals.push({ code: 'MANY_REPORTS_AGAINST', score: 35, detail: `${reportsAgainst} reports against user` });
  }

  if (profile?.displayName) {
    const duplicateNames = await Profile.countDocuments({ displayName: profile.displayName });
    if (duplicateNames >= 5) {
      signals.push({ code: 'DUPLICATE_DISPLAY_NAME', score: 20, detail: `${duplicateNames} profiles share this name` });
    }
  }

  const photoCount = profile?.photos?.length ?? 0;
  if (photoCount === 0) {
    const likesSent = await Swipe.countDocuments({ userId, action: { $in: ['LIKE', 'SUPER_LIKE'] } });
    if (likesSent >= MANY_LIKES_NO_PHOTOS) {
      signals.push({ code: 'NO_PHOTOS_MANY_LIKES', score: 25, detail: `${likesSent} likes sent with no photos` });
    }
  }

  const totalScore = signals.reduce((sum, signal) => sum + signal.score, 0);
  let doc = await UserRiskSignal.findOne({ userId, status: 'OPEN' });
  if (doc) {
    doc.signals = signals;
    doc.totalScore = totalScore;
    await doc.save();
  } else {
    doc = await UserRiskSignal.create({ userId, signals, totalScore, status: 'OPEN' });
  }

  await recordAudit(actor, {
    action: 'FRAUD_SCAN_RUN',
    targetType: 'USER',
    targetId: userId,
    metadata: { signalId: doc._id, totalScore, signalCodes: signals.map((s) => s.code) },
  });

  const cardFor = await loadUserCards([userId, doc.reviewedBy]);
  return presentSignal(doc.toObject ? doc.toObject() : doc, cardFor);
}

// GET /admin/fraud/signals
export async function listRiskSignals(filters, { limit, cursor }) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.userId) query.userId = filters.userId;

  const docs = await UserRiskSignal.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.flatMap((doc) => [doc.userId, doc.reviewedBy]));
  return { items: page.items.map((doc) => presentSignal(doc, cardFor)), nextCursor: page.nextCursor };
}

// PATCH /admin/fraud/signals/:id
export async function updateRiskSignal(actor, id, { status }) {
  const doc = await UserRiskSignal.findById(id);
  if (!doc) throw ApiError.notFound();

  const previous = doc.status;
  doc.status = status;
  doc.reviewedBy = actor.id;
  doc.reviewedAt = new Date();
  await doc.save();

  await recordAudit(actor, {
    action: 'FRAUD_SIGNAL_UPDATED',
    targetType: 'RISK_SIGNAL',
    targetId: id,
    metadata: { from: previous, to: status, userId: doc.userId },
  });

  const cardFor = await loadUserCards([doc.userId, doc.reviewedBy]);
  return presentSignal(doc.toObject(), cardFor);
}

export { RISK_STATUSES };
