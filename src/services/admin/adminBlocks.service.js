// Block management for staff: stats, trends, velocity queue, member investigation.
// List/investigate only — no silent admin unblock (member safety action).

import { Block } from '../../models/Block.js';
import { Match } from '../../models/Match.js';
import { Profile } from '../../models/Profile.js';
import { Report } from '../../models/Report.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { getSetting } from '../settings.service.js';
import { loadUserCards } from './adminPresenter.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_MATCHES = 500;
const VELOCITY_LIST_CAP = 100;
const DEFAULT_BLOCK_ABUSE_THRESHOLD = 20;

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

function buildPairKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

async function resolveSearchUserIds(q) {
  if (isValidId(q)) {
    if (q.startsWith('blk_')) return { blockId: q };
    return { userIds: [q] };
  }
  const pattern = new RegExp(escapeRegex(q), 'i');
  const nameMatches = await Profile.find({ displayName: pattern }).select('userId').limit(MAX_NAME_MATCHES).lean();
  return { userIds: nameMatches.map((profile) => profile.userId) };
}

async function getAbuseThreshold() {
  return (await getSetting('blockAbuseThresholdPerDay')) ?? DEFAULT_BLOCK_ABUSE_THRESHOLD;
}

async function mutualPairSet(pairs) {
  if (pairs.length === 0) return new Set();
  const or = pairs.map(([a, b]) => ({ blockerId: b, blockedId: a }));
  const reciprocal = await Block.find({ $or: or }).select('blockerId blockedId').lean();
  return new Set(reciprocal.map((block) => buildPairKey(block.blockerId, block.blockedId)));
}

async function reportCountsForPairs(pairs) {
  if (pairs.length === 0) return new Map();
  const userIds = [...new Set(pairs.flat())];
  const reports = await Report.find({
    status: { $in: ['OPEN', 'IN_REVIEW'] },
    reporterId: { $in: userIds },
    targetUserId: { $in: userIds },
  })
    .select('reporterId targetUserId')
    .lean();

  const counts = new Map();
  for (const report of reports) {
    const key = buildPairKey(report.reporterId, report.targetUserId);
    if (!pairs.some(([a, b]) => buildPairKey(a, b) === key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function presentBlock(block, cardFor, { mutual = false, openReports = 0 } = {}) {
  return {
    id: block._id,
    blocker: cardFor(block.blockerId),
    blocked: cardFor(block.blockedId),
    createdAt: block.createdAt,
    mutual,
    openReportsBetween: openReports,
  };
}

// GET /admin/blocks — newest first.
export async function listBlocks(filters, { limit, cursor }) {
  const query = {};
  if (filters.blockerId) query.blockerId = filters.blockerId;
  if (filters.blockedId) query.blockedId = filters.blockedId;

  if (filters.q) {
    const resolved = await resolveSearchUserIds(filters.q);
    if (resolved.blockId) query._id = resolved.blockId;
    else if (resolved.userIds?.length) {
      query.$or = [{ blockerId: { $in: resolved.userIds } }, { blockedId: { $in: resolved.userIds } }];
    } else {
      return { items: [], nextCursor: null };
    }
  }

  if (filters.mutual === 'true') {
    // Mutual blocks: A blocked B and B blocked A. Resolve via aggregation.
    const mutualDocs = await Block.aggregate([
      { $match: { ...query, ...getAfterCursorFilter(cursor) } },
      {
        $lookup: {
          from: 'blocks',
          let: { blocker: '$blockerId', blocked: '$blockedId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ['$blockerId', '$$blocked'] }, { $eq: ['$blockedId', '$$blocker'] }],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'reciprocal',
        },
      },
      { $match: { 'reciprocal.0': { $exists: true } } },
      { $sort: getPageSort() },
      { $limit: limit + 1 },
    ]);
    const page = buildPage(mutualDocs, limit);
    const cardFor = await loadUserCards(page.items.flatMap((block) => [block.blockerId, block.blockedId]));
    const pairs = page.items.map((block) => [block.blockerId, block.blockedId]);
    const reportCounts = await reportCountsForPairs(pairs);
    return {
      items: page.items.map((block) =>
        presentBlock(block, cardFor, {
          mutual: true,
          openReports: reportCounts.get(buildPairKey(block.blockerId, block.blockedId)) ?? 0,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  const docs = await Block.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.flatMap((block) => [block.blockerId, block.blockedId]));
  const pairs = page.items.map((block) => [block.blockerId, block.blockedId]);
  const [mutualKeys, reportCounts] = await Promise.all([mutualPairSet(pairs), reportCountsForPairs(pairs)]);

  return {
    items: page.items.map((block) => {
      const key = buildPairKey(block.blockerId, block.blockedId);
      return presentBlock(block, cardFor, {
        mutual: mutualKeys.has(key),
        openReports: reportCounts.get(key) ?? 0,
      });
    }),
    nextCursor: page.nextCursor,
  };
}

// GET /admin/blocks/stats?days=
export async function getBlockStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);
  const todayStart = startOfUtcDay();
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const threshold = await getAbuseThreshold();

  const [total, newInRange, newToday, newYesterday, uniqueBlockers, uniqueBlocked, mutualAgg, velocityCount] =
    await Promise.all([
      Block.countDocuments(),
      Block.countDocuments({ createdAt: { $gte: since } }),
      Block.countDocuments({ createdAt: { $gte: todayStart } }),
      Block.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
      Block.distinct('blockerId').then((ids) => ids.length),
      Block.distinct('blockedId').then((ids) => ids.length),
      Block.aggregate([
        {
          $lookup: {
            from: 'blocks',
            let: { blocker: '$blockerId', blocked: '$blockedId' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$blockerId', '$$blocked'] }, { $eq: ['$blockedId', '$$blocker'] }],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'reciprocal',
          },
        },
        { $match: { 'reciprocal.0': { $exists: true } } },
        // Each mutual pair is counted twice (A→B and B→A); divide later.
        { $count: 'count' },
      ]),
      Block.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - DAY_MS) } } },
        { $group: { _id: '$blockerId', count: { $sum: 1 } } },
        { $match: { count: { $gte: threshold } } },
        { $count: 'count' },
      ]),
    ]);

  const mutualRaw = mutualAgg[0]?.count ?? 0;
  const mutualBlocks = Math.floor(mutualRaw / 2);

  return {
    days: range,
    total,
    newInRange,
    newToday,
    todayDelta: newToday - newYesterday,
    uniqueBlockers,
    uniqueBlocked,
    mutualBlocks,
    highVelocityBlockers: velocityCount[0]?.count ?? 0,
    abuseThreshold: threshold,
  };
}

// GET /admin/blocks/analytics?days=
export async function getBlockAnalytics({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);

  const [daily, topBlockers, topBlocked] = await Promise.all([
    Block.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          blocks: { $sum: 1 },
        },
      },
    ]),
    Block.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$blockerId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Block.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$blockedId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const byDay = new Map(dayBuckets(range).map((day) => [day, { day, blocks: 0 }]));
  for (const row of daily) {
    const bucket = byDay.get(row._id);
    if (bucket) bucket.blocks = row.blocks;
  }

  const cardFor = await loadUserCards([
    ...topBlockers.map((row) => row._id),
    ...topBlocked.map((row) => row._id),
  ]);

  return {
    days: range,
    series: [...byDay.values()],
    topBlockers: topBlockers.map((row) => ({ user: cardFor(row._id), count: row.count })),
    topBlocked: topBlocked.map((row) => ({ user: cardFor(row._id), count: row.count })),
  };
}

// GET /admin/blocks/velocity — members over the block-abuse threshold in 24h.
export async function listBlockVelocity() {
  const threshold = await getAbuseThreshold();
  const since = new Date(Date.now() - DAY_MS);

  const grouped = await Block.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$blockerId',
        blockCount: { $sum: 1 },
        lastBlockedAt: { $max: '$createdAt' },
        sampleBlockedIds: { $push: '$blockedId' },
      },
    },
    { $match: { blockCount: { $gte: threshold } } },
    { $sort: { blockCount: -1, lastBlockedAt: -1 } },
    { $limit: VELOCITY_LIST_CAP },
  ]);

  const cardFor = await loadUserCards([
    ...grouped.map((row) => row._id),
    ...grouped.flatMap((row) => row.sampleBlockedIds.slice(0, 3)),
  ]);

  return {
    threshold,
    items: grouped.map((row) => ({
      user: cardFor(row._id),
      blockCount: row.blockCount,
      overBy: row.blockCount - threshold,
      lastBlockedAt: row.lastBlockedAt,
      recentBlocked: row.sampleBlockedIds.slice(0, 3).map((id) => cardFor(id)),
    })),
  };
}

// GET /admin/blocks/:blockId
export async function getBlockDetail(blockId) {
  const block = await Block.findById(blockId).lean();
  if (!block) throw ApiError.notFound();

  const pairKey = buildPairKey(block.blockerId, block.blockedId);
  const [cardFor, reciprocal, match, reports] = await Promise.all([
    loadUserCards([block.blockerId, block.blockedId]),
    Block.findOne({ blockerId: block.blockedId, blockedId: block.blockerId }).lean(),
    Match.findOne({ pairKey }).lean(),
    Report.find({
      $or: [
        { reporterId: block.blockerId, targetUserId: block.blockedId },
        { reporterId: block.blockedId, targetUserId: block.blockerId },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);

  return {
    ...presentBlock(block, cardFor, {
      mutual: Boolean(reciprocal),
      openReports: reports.filter((report) => ['OPEN', 'IN_REVIEW'].includes(report.status)).length,
    }),
    reciprocalBlockId: reciprocal?._id ?? null,
    match: match
      ? {
          id: match._id,
          status: match.status,
          endedReason: match.endedReason ?? null,
          matchedAt: match.matchedAt ?? null,
          endedAt: match.endedAt ?? null,
        }
      : null,
    reports: reports.map((report) => ({
      id: report._id,
      status: report.status,
      reason: report.reason,
      reporter: cardFor(report.reporterId),
      targetUser: cardFor(report.targetUserId),
      createdAt: report.createdAt,
    })),
    policyNote:
      'Staff cannot silently remove a member-initiated block from this panel. Use user status / moderation tools when policy requires action, and audit the reason.',
  };
}

// GET /admin/blocks/members/:userId/report
export async function getMemberBlockReport(userId) {
  if (!isValidId(userId)) throw ApiError.notFound();
  const [cardFor, blockedByUser, blockedUser, sent, received] = await Promise.all([
    loadUserCards([userId]),
    Block.countDocuments({ blockerId: userId }),
    Block.countDocuments({ blockedId: userId }),
    Block.find({ blockerId: userId }).sort({ createdAt: -1 }).limit(20).lean(),
    Block.find({ blockedId: userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const user = cardFor(userId);
  if (!user || user.status === 'DELETED') throw ApiError.notFound();

  const otherIds = [...sent.map((b) => b.blockedId), ...received.map((b) => b.blockerId)];
  const others = await loadUserCards(otherIds);

  return {
    user,
    totals: {
      blocksSent: blockedByUser,
      blocksReceived: blockedUser,
    },
    recentSent: sent.map((block) => ({
      id: block._id,
      user: others(block.blockedId),
      createdAt: block.createdAt,
    })),
    recentReceived: received.map((block) => ({
      id: block._id,
      user: others(block.blockerId),
      createdAt: block.createdAt,
    })),
  };
}
