// Swipe & like management for staff: volume stats, conversion analytics, abuse detection,
// per-member sent/received/pass history, and entitlement (quota / rewind) settings.

import { EDITABLE_SETTINGS } from '../../config/catalog.js';
import { LIKE_ACTIONS, SWIPE_ACTIONS, Swipe } from '../../models/Swipe.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { getEditableSettings, getSetting, saveSettings } from '../settings.service.js';
import { isPremium, presentEntitlement } from '../subscription.service.js';
import { loadUserCards } from './adminPresenter.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWIPE_SETTING_KEYS = ['freeDailyLikes', 'freeDailySuperLikes', 'freeDailyRewinds', 'swipeAbuseThresholdPerDay'];
const ABUSE_LIST_CAP = 100;

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayBuckets(days) {
  const buckets = [];
  const today = startOfUtcDay();
  for (let i = days - 1; i >= 0; i -= 1) {
    buckets.push(new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  }
  return buckets;
}

// GET /admin/swipes/stats?days=
export async function getSwipeStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);
  const inRange = { createdAt: { $gte: since } };
  const today = new Date(Date.now() - DAY_MS);

  const [
    likes,
    passes,
    superLikes,
    matchesCreated,
    likesSentToday,
    passesToday,
    superLikesToday,
    uniqueSwingers,
    premiumActive,
    freeDailyLikes,
    freeDailySuperLikes,
    freeDailyRewinds,
    abuseThreshold,
    pendingLikes,
  ] = await Promise.all([
    Swipe.countDocuments({ ...inRange, action: 'LIKE' }),
    Swipe.countDocuments({ ...inRange, action: 'PASS' }),
    Swipe.countDocuments({ ...inRange, action: 'SUPER_LIKE' }),
    Swipe.countDocuments({ ...inRange, matchId: { $type: 'string' } }),
    Swipe.countDocuments({ action: 'LIKE', createdAt: { $gte: today } }),
    Swipe.countDocuments({ action: 'PASS', createdAt: { $gte: today } }),
    Swipe.countDocuments({ action: 'SUPER_LIKE', createdAt: { $gte: today } }),
    Swipe.distinct('userId', inRange).then((ids) => ids.length),
    SubscriptionEntitlement.countDocuments({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }),
    getSetting('freeDailyLikes'),
    getSetting('freeDailySuperLikes'),
    getSetting('freeDailyRewinds'),
    getSetting('swipeAbuseThresholdPerDay'),
    Swipe.countDocuments({ ...inRange, action: { $in: LIKE_ACTIONS }, matchId: null }),
  ]);

  const likeActions = likes + superLikes;
  const totalSwipes = likeActions + passes;
  const conversion = likeActions > 0 ? Math.round((matchesCreated / likeActions) * 1000) / 10 : 0;
  const likeRate = totalSwipes > 0 ? Math.round((likeActions / totalSwipes) * 1000) / 10 : 0;
  const passRate = totalSwipes > 0 ? Math.round((passes / totalSwipes) * 1000) / 10 : 0;

  return {
    days: range,
    likes,
    passes,
    superLikes,
    priorityLikes: superLikes,
    likesSent: likeActions,
    likesReceived: likeActions,
    pendingLikes,
    matchesCreated,
    conversion,
    likeRate,
    passRate,
    totalSwipes,
    uniqueSwingers,
    today: { likes: likesSentToday, passes: passesToday, superLikes: superLikesToday },
    entitlements: {
      premiumActive,
      freeDailyLikes,
      freeDailySuperLikes,
      freeDailyRewinds,
      abuseThreshold,
      rewindPremiumOnly: freeDailyRewinds === 0,
    },
  };
}

// GET /admin/swipes/analytics?days=
export async function getSwipeAnalytics({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);

  const [daily, actionMix, matchByAction] = await Promise.all([
    Swipe.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            action: '$action',
          },
          count: { $sum: 1 },
          matches: { $sum: { $cond: [{ $eq: [{ $type: '$matchId' }, 'string'] }, 1, 0] } },
        },
      },
    ]),
    Swipe.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
    Swipe.aggregate([
      { $match: { createdAt: { $gte: since }, action: { $in: LIKE_ACTIONS } } },
      {
        $group: {
          _id: '$action',
          likes: { $sum: 1 },
          matches: { $sum: { $cond: [{ $eq: [{ $type: '$matchId' }, 'string'] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const byDay = new Map();
  for (const key of dayBuckets(range)) {
    byDay.set(key, { day: key, likes: 0, passes: 0, superLikes: 0, matches: 0 });
  }
  for (const row of daily) {
    const bucket = byDay.get(row._id.day);
    if (!bucket) continue;
    if (row._id.action === 'LIKE') bucket.likes += row.count;
    if (row._id.action === 'PASS') bucket.passes += row.count;
    if (row._id.action === 'SUPER_LIKE') bucket.superLikes += row.count;
    bucket.matches += row.matches;
  }

  const series = [...byDay.values()].map((row) => {
    const likeActions = row.likes + row.superLikes;
    return {
      ...row,
      conversion: likeActions > 0 ? Math.round((row.matches / likeActions) * 1000) / 10 : 0,
    };
  });

  return {
    days: range,
    series,
    actionMix: Object.fromEntries(actionMix.map((row) => [row._id, row.count])),
    recommendationPerformance: matchByAction.map((row) => ({
      action: row._id,
      likes: row.likes,
      matches: row.matches,
      conversion: row.likes > 0 ? Math.round((row.matches / row.likes) * 1000) / 10 : 0,
    })),
  };
}

// GET /admin/swipes/abuse — members over the abuse threshold in the last 24h.
export async function listSwipeAbuse() {
  const threshold = Number(await getSetting('swipeAbuseThresholdPerDay')) || 80;
  const since = new Date(Date.now() - DAY_MS);

  const grouped = await Swipe.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$userId',
        swipeCount: { $sum: 1 },
        likes: { $sum: { $cond: [{ $eq: ['$action', 'LIKE'] }, 1, 0] } },
        passes: { $sum: { $cond: [{ $eq: ['$action', 'PASS'] }, 1, 0] } },
        superLikes: { $sum: { $cond: [{ $eq: ['$action', 'SUPER_LIKE'] }, 1, 0] } },
        lastSwipeAt: { $max: '$createdAt' },
      },
    },
    { $match: { swipeCount: { $gte: threshold } } },
    { $sort: { swipeCount: -1, lastSwipeAt: -1 } },
    { $limit: ABUSE_LIST_CAP },
  ]);

  const cardFor = await loadUserCards(grouped.map((row) => row._id));
  const premiumFlags = await Promise.all(grouped.map((row) => isPremium(row._id)));

  return {
    threshold,
    windowHours: 24,
    items: grouped.map((row, index) => ({
      user: cardFor(row._id),
      userId: row._id,
      swipeCount: row.swipeCount,
      likes: row.likes,
      passes: row.passes,
      superLikes: row.superLikes,
      lastSwipeAt: row.lastSwipeAt,
      isPremium: premiumFlags[index],
      overBy: Math.max(0, row.swipeCount - threshold),
    })),
  };
}

// GET /admin/swipes?userId=&action=&direction=sent|received
export async function listSwipes(filters, { limit, cursor }) {
  if (!filters.userId) throw ApiError.validation([{ field: 'userId', reason: 'REQUIRED' }]);
  if (!(await User.exists({ _id: filters.userId }))) throw ApiError.notFound();

  const query = {};
  if (filters.direction === 'received') query.targetUserId = filters.userId;
  else query.userId = filters.userId;
  if (filters.action) query.action = filters.action;

  const docs = await Swipe.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.flatMap((swipe) => [swipe.userId, swipe.targetUserId]));

  return {
    items: page.items.map((swipe) => ({
      id: swipe._id,
      action: swipe.action,
      direction: filters.direction === 'received' ? 'received' : 'sent',
      user: cardFor(swipe.userId),
      targetUser: cardFor(swipe.targetUserId),
      matchId: swipe.matchId ?? null,
      createdAt: swipe.createdAt,
    })),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/swipes/members/:userId/report
export async function getMemberSwipeReport(userId) {
  const user = await User.findById(userId).select('email role status rewindQuota').lean();
  if (!user || user.role !== 'USER') throw ApiError.notFound();

  const since = new Date(Date.now() - DAY_MS);
  const entitlementDoc = await SubscriptionEntitlement.findOne({ userId }).lean();
  const [
    cardFor,
    premium,
    freeDailyLikes,
    freeDailySuperLikes,
    freeDailyRewinds,
    likesSent,
    passesSent,
    superLikesSent,
    likesReceived,
    matchesFromLikes,
    likesSentToday,
    superLikesSentToday,
    totalSent,
    totalReceived,
  ] = await Promise.all([
    loadUserCards([userId]),
    isPremium(userId),
    getSetting('freeDailyLikes'),
    getSetting('freeDailySuperLikes'),
    getSetting('freeDailyRewinds'),
    Swipe.countDocuments({ userId, action: 'LIKE' }),
    Swipe.countDocuments({ userId, action: 'PASS' }),
    Swipe.countDocuments({ userId, action: 'SUPER_LIKE' }),
    Swipe.countDocuments({ targetUserId: userId, action: { $in: LIKE_ACTIONS } }),
    Swipe.countDocuments({ userId, action: { $in: LIKE_ACTIONS }, matchId: { $type: 'string' } }),
    Swipe.countDocuments({ userId, action: 'LIKE', createdAt: { $gte: since } }),
    Swipe.countDocuments({ userId, action: 'SUPER_LIKE', createdAt: { $gte: since } }),
    Swipe.countDocuments({ userId }),
    Swipe.countDocuments({ targetUserId: userId }),
  ]);

  const likeActions = likesSent + superLikesSent;
  const conversion = likeActions > 0 ? Math.round((matchesFromLikes / likeActions) * 1000) / 10 : 0;
  const windowStart = new Date(Date.now() - DAY_MS);
  const rewindUsed =
    user.rewindQuota?.windowStartedAt && new Date(user.rewindQuota.windowStartedAt) >= windowStart
      ? user.rewindQuota.used ?? 0
      : 0;

  return {
    user: cardFor(userId),
    entitlement: presentEntitlement(entitlementDoc),
    isPremium: premium,
    totals: {
      likesSent,
      passesSent,
      superLikesSent,
      priorityLikesSent: superLikesSent,
      likesReceived,
      matchesFromLikes,
      conversion,
      totalSent,
      totalReceived,
    },
    today: {
      likesSent: likesSentToday,
      superLikesSent: superLikesSentToday,
      likesRemaining: premium ? null : Math.max(0, freeDailyLikes - likesSentToday),
      superLikesRemaining: premium ? null : Math.max(0, freeDailySuperLikes - superLikesSentToday),
      rewindsUsed: rewindUsed,
      rewindsRemaining: premium ? null : freeDailyRewinds > 0 ? Math.max(0, freeDailyRewinds - rewindUsed) : 0,
    },
    limits: {
      freeDailyLikes,
      freeDailySuperLikes,
      freeDailyRewinds,
      rewindPremiumOnly: freeDailyRewinds === 0,
    },
  };
}

// GET /admin/swipes/entitlements
export async function getSwipeEntitlements() {
  const settings = (await getEditableSettings()).filter((setting) => SWIPE_SETTING_KEYS.includes(setting.key));
  const premiumActive = await SubscriptionEntitlement.countDocuments({
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  return {
    settings,
    catalog: Object.fromEntries(SWIPE_SETTING_KEYS.map((key) => [key, EDITABLE_SETTINGS[key]])),
    premiumActive,
    notes: {
      priorityLikes: 'Priority likes are implemented as SUPER_LIKE actions.',
      rewind: 'Rewind (undo last swipe) is unlimited for premium; free members use freeDailyRewinds (0 = premium only).',
      rateLimit: 'API rate limit is 120 swipes/minute per member; abuse queue uses swipeAbuseThresholdPerDay.',
    },
  };
}

// PATCH /admin/swipes/entitlements
export async function updateSwipeEntitlements(actor, changes) {
  const allowed = {};
  for (const key of SWIPE_SETTING_KEYS) {
    if (changes[key] !== undefined) allowed[key] = changes[key];
  }
  if (Object.keys(allowed).length === 0) {
    throw ApiError.validation([{ field: 'body', reason: 'NO_FIELDS' }]);
  }
  await saveSettings(allowed, actor.id);
  await recordAudit(actor, {
    action: 'SWIPE_ENTITLEMENTS_UPDATED',
    targetType: 'SETTINGS',
    targetId: 'swipe',
    metadata: { changes: allowed },
  });
  const settings = (await getEditableSettings()).filter((setting) => SWIPE_SETTING_KEYS.includes(setting.key));
  return { settings };
}

export { SWIPE_ACTIONS };
