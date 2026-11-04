// Match management for staff: stats, trends, conversion, algorithm config, fraud/suspicious
// queues, reported-match investigation, and match detail (message counts only — never text).

import { EDITABLE_SETTINGS } from '../../config/catalog.js';
import { Match, MATCH_END_REASONS, MATCH_STATUSES } from '../../models/Match.js';
import { Message } from '../../models/Message.js';
import { Profile } from '../../models/Profile.js';
import { Report } from '../../models/Report.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { recordAudit } from '../audit.service.js';
import { endMatch } from '../match.service.js';
import { getEditableSettings, getSetting, saveSettings } from '../settings.service.js';
import { loadUserCards } from './adminPresenter.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_MATCHES = 500;
const SUSPICIOUS_LIST_CAP = 100;
const QUICK_UNMATCH_MS = 5 * 60 * 1000;
const MATCH_SETTING_KEYS = ['matchExpiryDays', 'matchInactiveDays', 'matchAlgorithmVersion', 'matchFraudNewMatchesPerDay'];
export const MATCH_BUCKETS = ['active', 'inactive', 'unmatched', 'expired'];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function weekKey(isoDay) {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(isoDay) {
  return isoDay.slice(0, 7);
}

async function resolveSearchUserIds(q) {
  if (isValidId(q)) {
    if (q.startsWith('mat_')) return { matchId: q };
    return { userIds: [q] };
  }
  const pattern = new RegExp(escapeRegex(q), 'i');
  const [nameMatches, emailMatches] = await Promise.all([
    Profile.find({ displayName: pattern }).select('userId').limit(MAX_NAME_MATCHES).lean(),
    User.find({ email: pattern }).select('_id').limit(MAX_NAME_MATCHES).lean(),
  ]);
  return {
    userIds: [...new Set([...nameMatches.map((profile) => profile.userId), ...emailMatches.map((user) => user._id)])],
  };
}

async function messageCountsFor(conversationIds) {
  if (conversationIds.length === 0) return new Map();
  const counts = await Message.aggregate([
    { $match: { conversationId: { $in: conversationIds } } },
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((entry) => [entry._id, entry.count]));
}

async function conversationsWithMessages(conversationIds) {
  if (conversationIds.length === 0) return new Set();
  const rows = await Message.aggregate([
    { $match: { conversationId: { $in: conversationIds } } },
    { $group: { _id: '$conversationId' } },
  ]);
  return new Set(rows.map((row) => row._id));
}

function presentLifecycle(match, messageCount, inactiveCutoff, now = new Date()) {
  if (match.status === 'ENDED') {
    if (match.endedReason === 'EXPIRED') return 'expired';
    if (match.endedReason === 'UNMATCH') return 'unmatched';
    return 'ended';
  }
  if (match.expiresAt && new Date(match.expiresAt) <= now) return 'expired';
  const activityAt = match.matchedAt ?? match.createdAt;
  if (messageCount === 0 && activityAt && new Date(activityAt) < inactiveCutoff) return 'inactive';
  return 'active';
}

function presentMatchRow(match, cardFor, messageCount, inactiveCutoff) {
  const lifecycle = presentLifecycle(match, messageCount, inactiveCutoff);
  return {
    id: match._id,
    status: match.status,
    lifecycle,
    users: (match.userIds ?? []).map((id) => cardFor(id)).filter(Boolean),
    matchedAt: match.matchedAt ?? match.createdAt,
    endedAt: match.endedAt ?? null,
    endedReason: match.endedReason ?? null,
    conversationId: match.conversationId ?? null,
    messageCount,
    chatStarted: messageCount > 0,
    algorithmVersion: match.algorithmVersion ?? 'v1',
    compatibilityScore: match.compatibilityScore ?? null,
    expiresAt: match.expiresAt ?? null,
  };
}

async function inactiveCutoffDate() {
  const days = await getSetting('matchInactiveDays');
  return new Date(Date.now() - days * DAY_MS);
}

// GET /admin/matches — newest matches first, with both user cards and messageCount.
export async function listMatches(filters, { limit, cursor }) {
  const query = {};
  const now = new Date();
  const inactiveCutoff = await inactiveCutoffDate();

  if (filters.status) query.status = filters.status;
  if (filters.algorithmVersion) query.algorithmVersion = filters.algorithmVersion;

  if (filters.bucket === 'unmatched') {
    query.status = 'ENDED';
    query.endedReason = 'UNMATCH';
  } else if (filters.bucket === 'expired') {
    query.$or = [
      { status: 'ENDED', endedReason: 'EXPIRED' },
      { status: 'ACTIVE', expiresAt: { $lte: now } },
    ];
  } else if (filters.bucket === 'active') {
    query.status = 'ACTIVE';
    query.$and = [{ $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] }];
  }

  if (filters.q) {
    const resolved = await resolveSearchUserIds(filters.q);
    if (resolved.matchId) query._id = resolved.matchId;
    else if (resolved.userIds?.length) query.userIds = { $in: resolved.userIds };
    else return { items: [], nextCursor: null };
  }

  const cursorFilter = getAfterCursorFilter(cursor, 'matchedAt');
  let docs;
  if (filters.bucket === 'inactive') {
    const pipeline = [
      { $match: mergeFilters(query, { status: 'ACTIVE' }, cursorFilter) },
      {
        $lookup: {
          from: 'messages',
          localField: 'conversationId',
          foreignField: 'conversationId',
          as: 'msgs',
          pipeline: [{ $limit: 1 }],
        },
      },
      {
        $match: {
          msgs: { $size: 0 },
          matchedAt: { $lt: inactiveCutoff },
        },
      },
      { $sort: getPageSort('matchedAt') },
      { $limit: limit + 1 },
    ];
    docs = await Match.aggregate(pipeline);
  } else {
    docs = await Match.find(mergeFilters(query, cursorFilter))
      .sort(getPageSort('matchedAt'))
      .limit(limit + 1)
      .lean();
  }

  const page = buildPage(docs, limit, 'matchedAt');
  const countByConversation = await messageCountsFor(page.items.map((match) => match.conversationId).filter(Boolean));
  const cardFor = await loadUserCards(page.items.flatMap((match) => match.userIds));

  let items = page.items.map((match) =>
    presentMatchRow(match, cardFor, countByConversation.get(match.conversationId) ?? 0, inactiveCutoff),
  );

  if (filters.bucket === 'active') {
    items = items.filter((item) => item.lifecycle === 'active');
  }

  return { items, nextCursor: page.nextCursor };
}

// GET /admin/matches/stats?days=
export async function getMatchStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);
  const todayStart = startOfUtcDay();
  const previousTodayStart = new Date(todayStart.getTime() - DAY_MS);
  const now = new Date();
  const inactiveCutoff = await inactiveCutoffDate();
  const [expiryDays, inactiveDays, algoVersion, fraudThreshold] = await Promise.all([
    getSetting('matchExpiryDays'),
    getSetting('matchInactiveDays'),
    getSetting('matchAlgorithmVersion'),
    getSetting('matchFraudNewMatchesPerDay'),
  ]);

  const [
    total,
    active,
    ended,
    newInRange,
    newToday,
    newYesterday,
    unmatched,
    expiredEnded,
    expiredActive,
    withMessages,
    inactiveAgg,
  ] = await Promise.all([
    Match.countDocuments(),
    Match.countDocuments({ status: 'ACTIVE' }),
    Match.countDocuments({ status: 'ENDED' }),
    Match.countDocuments({ matchedAt: { $gte: since } }),
    Match.countDocuments({ matchedAt: { $gte: todayStart } }),
    Match.countDocuments({ matchedAt: { $gte: previousTodayStart, $lt: todayStart } }),
    Match.countDocuments({ status: 'ENDED', endedReason: 'UNMATCH' }),
    Match.countDocuments({ status: 'ENDED', endedReason: 'EXPIRED' }),
    Match.countDocuments({ status: 'ACTIVE', expiresAt: { $lte: now } }),
    Match.aggregate([
      { $match: { matchedAt: { $gte: since } } },
      {
        $lookup: {
          from: 'messages',
          localField: 'conversationId',
          foreignField: 'conversationId',
          as: 'msgs',
          pipeline: [{ $limit: 1 }],
        },
      },
      { $match: { 'msgs.0': { $exists: true } } },
      { $count: 'count' },
    ]),
    Match.aggregate([
      { $match: { status: 'ACTIVE', matchedAt: { $lt: inactiveCutoff } } },
      {
        $lookup: {
          from: 'messages',
          localField: 'conversationId',
          foreignField: 'conversationId',
          as: 'msgs',
          pipeline: [{ $limit: 1 }],
        },
      },
      { $match: { msgs: { $size: 0 } } },
      { $count: 'count' },
    ]),
  ]);

  const chatsStarted = withMessages[0]?.count ?? 0;
  const matchToChatConversion = newInRange > 0 ? Math.round((chatsStarted / newInRange) * 1000) / 10 : 0;
  const inactive = inactiveAgg[0]?.count ?? 0;
  const expired = expiredEnded + expiredActive;
  const todayDelta = newToday - newYesterday;

  return {
    days: range,
    total,
    active,
    inactive,
    ended,
    unmatched,
    expired,
    newInRange,
    newToday,
    todayDelta,
    chatsStarted,
    matchToChatConversion,
    config: {
      matchExpiryDays: expiryDays,
      matchInactiveDays: inactiveDays,
      matchAlgorithmVersion: algoVersion,
      algorithmLabel: `v${algoVersion}`,
      matchFraudNewMatchesPerDay: fraudThreshold,
    },
  };
}

// GET /admin/matches/analytics?days=
export async function getMatchAnalytics({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);

  const [daily, endedReasons, algoRows] = await Promise.all([
    Match.aggregate([
      { $match: { matchedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$matchedAt' } },
          matches: { $sum: 1 },
          conversationIds: { $addToSet: '$conversationId' },
        },
      },
    ]),
    Match.aggregate([
      { $match: { status: 'ENDED', endedAt: { $gte: since } } },
      { $group: { _id: '$endedReason', count: { $sum: 1 } } },
    ]),
    Match.aggregate([
      { $match: { matchedAt: { $gte: since } } },
      {
        $group: {
          _id: { $ifNull: ['$algorithmVersion', 'v1'] },
          matches: { $sum: 1 },
          avgCompatibility: { $avg: '$compatibilityScore' },
          conversationIds: { $addToSet: '$conversationId' },
        },
      },
      { $sort: { matches: -1 } },
    ]),
  ]);

  const allConversationIds = [...new Set(daily.flatMap((row) => row.conversationIds).filter(Boolean))];
  const withChat = await conversationsWithMessages(allConversationIds);

  const byDay = new Map();
  for (const key of dayBuckets(range)) {
    byDay.set(key, { day: key, matches: 0, chatsStarted: 0, conversion: 0 });
  }
  for (const row of daily) {
    const bucket = byDay.get(row._id);
    if (!bucket) continue;
    bucket.matches = row.matches;
    bucket.chatsStarted = row.conversationIds.filter((id) => withChat.has(id)).length;
    bucket.conversion = bucket.matches > 0 ? Math.round((bucket.chatsStarted / bucket.matches) * 1000) / 10 : 0;
  }

  const series = [...byDay.values()];
  const weeklyMap = new Map();
  const monthlyMap = new Map();
  for (const row of series) {
    const w = weekKey(row.day);
    const m = monthKey(row.day);
    if (!weeklyMap.has(w)) weeklyMap.set(w, { period: w, matches: 0, chatsStarted: 0 });
    if (!monthlyMap.has(m)) monthlyMap.set(m, { period: m, matches: 0, chatsStarted: 0 });
    weeklyMap.get(w).matches += row.matches;
    weeklyMap.get(w).chatsStarted += row.chatsStarted;
    monthlyMap.get(m).matches += row.matches;
    monthlyMap.get(m).chatsStarted += row.chatsStarted;
  }

  const withConversion = (rows) =>
    rows.map((row) => ({
      ...row,
      conversion: row.matches > 0 ? Math.round((row.chatsStarted / row.matches) * 1000) / 10 : 0,
    }));

  const algorithmConversationIds = [...new Set(algoRows.flatMap((row) => row.conversationIds).filter(Boolean))];
  const algoChat = await conversationsWithMessages(algorithmConversationIds);

  return {
    days: range,
    series,
    weekly: withConversion([...weeklyMap.values()]),
    monthly: withConversion([...monthlyMap.values()]),
    endedReasons: Object.fromEntries(endedReasons.map((row) => [row._id ?? 'UNKNOWN', row.count])),
    algorithmPerformance: algoRows.map((row) => {
      const chatsStarted = row.conversationIds.filter((id) => algoChat.has(id)).length;
      return {
        version: row._id,
        matches: row.matches,
        avgCompatibility: row.avgCompatibility != null ? Math.round(row.avgCompatibility * 10) / 10 : null,
        chatsStarted,
        conversion: row.matches > 0 ? Math.round((chatsStarted / row.matches) * 1000) / 10 : 0,
      };
    }),
  };
}

// GET /admin/matches/suspicious
export async function listSuspiciousMatches() {
  const threshold = await getSetting('matchFraudNewMatchesPerDay');
  const since = new Date(Date.now() - DAY_MS);

  const [velocity, quickUnmatches] = await Promise.all([
    Match.aggregate([
      { $match: { matchedAt: { $gte: since } } },
      { $unwind: '$userIds' },
      {
        $group: {
          _id: '$userIds',
          matchCount: { $sum: 1 },
          lastMatchedAt: { $max: '$matchedAt' },
          matchIds: { $push: '$_id' },
        },
      },
      { $match: { matchCount: { $gte: threshold } } },
      { $sort: { matchCount: -1, lastMatchedAt: -1 } },
      { $limit: SUSPICIOUS_LIST_CAP },
    ]),
    Match.find({
      status: 'ENDED',
      endedReason: 'UNMATCH',
      endedAt: { $gte: since },
    })
      .sort({ endedAt: -1 })
      .limit(SUSPICIOUS_LIST_CAP)
      .lean(),
  ]);

  const quick = quickUnmatches.filter((match) => {
    if (!match.matchedAt || !match.endedAt) return false;
    return new Date(match.endedAt) - new Date(match.matchedAt) <= QUICK_UNMATCH_MS;
  });

  const userIds = [...velocity.map((row) => row._id), ...quick.flatMap((match) => match.userIds)];
  const cardFor = await loadUserCards(userIds);

  return {
    threshold,
    velocity: velocity.map((row) => ({
      user: cardFor(row._id),
      matchCount: row.matchCount,
      overBy: row.matchCount - threshold,
      lastMatchedAt: row.lastMatchedAt,
      sampleMatchIds: row.matchIds.slice(0, 5),
    })),
    quickUnmatches: quick.map((match) => ({
      id: match._id,
      users: match.userIds.map((id) => cardFor(id)),
      matchedAt: match.matchedAt,
      endedAt: match.endedAt,
      durationSeconds: Math.round((new Date(match.endedAt) - new Date(match.matchedAt)) / 1000),
    })),
  };
}

// GET /admin/matches/reported
export async function listReportedMatches({ limit, cursor } = { limit: 20, cursor: null }) {
  const openStatuses = ['OPEN', 'IN_REVIEW'];
  const reports = await Report.find({ status: { $in: openStatuses } })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  const pairKeys = new Set();
  const reportByPair = new Map();
  for (const report of reports) {
    if (!report.reporterId || !report.targetUserId) continue;
    const pairKey = [report.reporterId, report.targetUserId].sort().join(':');
    if (!reportByPair.has(pairKey)) reportByPair.set(pairKey, []);
    reportByPair.get(pairKey).push(report);
    pairKeys.add(pairKey);
  }

  if (pairKeys.size === 0) return { items: [], nextCursor: null };

  const matches = await Match.find({
    pairKey: { $in: [...pairKeys] },
    ...getAfterCursorFilter(cursor, 'matchedAt'),
  })
    .sort(getPageSort('matchedAt'))
    .limit(limit + 1)
    .lean();

  const page = buildPage(matches, limit, 'matchedAt');
  const cardFor = await loadUserCards(page.items.flatMap((match) => match.userIds));
  const countByConversation = await messageCountsFor(page.items.map((match) => match.conversationId).filter(Boolean));
  const inactiveCutoff = await inactiveCutoffDate();

  return {
    items: page.items.map((match) => {
      const relatedReports = reportByPair.get(match.pairKey) ?? [];
      return {
        ...presentMatchRow(match, cardFor, countByConversation.get(match.conversationId) ?? 0, inactiveCutoff),
        reports: relatedReports.map((report) => ({
          id: report._id,
          status: report.status,
          reason: report.reason,
          reporterId: report.reporterId,
          targetUserId: report.targetUserId,
          history: report.history ?? [],
          createdAt: report.createdAt,
          resolutionNote: report.resolutionNote ?? null,
        })),
      };
    }),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/matches/:matchId
export async function getMatchDetail(matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match) throw ApiError.notFound();

  const inactiveCutoff = await inactiveCutoffDate();
  const [cardFor, messageCount, relatedReports] = await Promise.all([
    loadUserCards(match.userIds),
    messageCountsFor([match.conversationId]).then((map) => map.get(match.conversationId) ?? 0),
    Report.find({
      $or: [
        { reporterId: { $in: match.userIds }, targetUserId: { $in: match.userIds } },
        { targetUserId: { $in: match.userIds }, reporterId: { $in: match.userIds } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);

  const row = presentMatchRow(match, cardFor, messageCount, inactiveCutoff);
  return {
    ...row,
    statusHistory: match.statusHistory ?? [],
    endedBy: match.endedBy ?? null,
    reports: relatedReports
      .filter((report) => match.userIds.includes(report.reporterId) && match.userIds.includes(report.targetUserId))
      .map((report) => ({
        id: report._id,
        status: report.status,
        reason: report.reason,
        reporter: cardFor(report.reporterId),
        targetUser: cardFor(report.targetUserId),
        history: report.history ?? [],
        createdAt: report.createdAt,
        resolutionNote: report.resolutionNote ?? null,
        resolvedAt: report.resolvedAt ?? null,
      })),
  };
}

// POST /admin/matches/:matchId/end
export async function endMatchByAdmin(actor, matchId, reason = 'MODERATION') {
  if (!MATCH_END_REASONS.includes(reason) || reason === 'UNMATCH') {
    throw ApiError.validation([{ field: 'reason', reason: 'INVALID' }]);
  }
  const match = await Match.findById(matchId);
  if (!match) throw ApiError.notFound();
  if (match.status !== 'ACTIVE') {
    throw ApiError.validation([{ field: 'status', reason: 'NOT_ACTIVE' }]);
  }
  await endMatch(match, reason, actor.id);
  await recordAudit(actor, {
    action: 'MATCH_ENDED_BY_ADMIN',
    targetType: 'MATCH',
    targetId: matchId,
    metadata: { reason, userIds: match.userIds },
  });
  return getMatchDetail(matchId);
}

// GET /admin/matches/config
export async function getMatchConfig() {
  const settings = (await getEditableSettings()).filter((setting) => MATCH_SETTING_KEYS.includes(setting.key));
  return {
    settings,
    catalog: Object.fromEntries(MATCH_SETTING_KEYS.map((key) => [key, EDITABLE_SETTINGS[key]])),
    notes: {
      expiry: 'matchExpiryDays stamps expiresAt on newly created matches (0 = never). Existing matches are unchanged; member APIs expire lazily when expiresAt passes.',
      inactive: 'matchInactiveDays defines when an ACTIVE match with no messages is counted as inactive in admin stats.',
      algorithm: 'matchAlgorithmVersion is stamped as v{n} on new matches and used in algorithm performance analytics.',
      fraud: 'Members creating at least matchFraudNewMatchesPerDay matches in 24h appear on the suspicious queue.',
      scoring: 'Compatibility score is shared-interest overlap (0–100) at match creation; preferences are not overridden for mobile discovery here.',
    },
  };
}

// PATCH /admin/matches/config
export async function updateMatchConfig(actor, changes) {
  const allowed = {};
  for (const key of MATCH_SETTING_KEYS) {
    if (changes[key] !== undefined) allowed[key] = changes[key];
  }
  if (Object.keys(allowed).length === 0) {
    throw ApiError.validation([{ field: 'body', reason: 'NO_FIELDS' }]);
  }
  const previous = await saveSettings(allowed, actor.id);
  await recordAudit(actor, {
    action: 'MATCH_CONFIG_UPDATED',
    targetType: 'SETTINGS',
    targetId: 'matches',
    metadata: {
      changes: Object.fromEntries(Object.entries(allowed).map(([key, value]) => [key, { from: previous[key], to: value }])),
    },
  });
  const settings = (await getEditableSettings()).filter((setting) => MATCH_SETTING_KEYS.includes(setting.key));
  return { settings };
}

export { MATCH_STATUSES, MATCH_SETTING_KEYS };
