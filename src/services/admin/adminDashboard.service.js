// Dashboard numbers, all counted live from MongoDB (nothing is estimated or made up).

import { Match } from '../../models/Match.js';
import { Message } from '../../models/Message.js';
import { Profile } from '../../models/Profile.js';
import { Report } from '../../models/Report.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { SupportTicket } from '../../models/SupportTicket.js';
import { User } from '../../models/User.js';
import { VerificationRequest } from '../../models/VerificationRequest.js';
import { getOnlineUserCount } from '../realtime.service.js';
import { getSystemInfo } from '../settings.service.js';
import { presentReportSummaries } from './adminReports.service.js';
import { loadUserCards, maskEmail } from './adminPresenter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_DAYS = 7;
const RECENT_LIMIT = 8;
const FOLLOW_UP_LIMIT = 8;
const MAX_CUSTOM_DAYS = 366;
export const DASHBOARD_RANGES = [7, 30, 90];

// Midnight UTC of the given date.
function startOfUtcDay(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function ymd(date) {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

// Resolves either a custom from/to window or a preset days window (ending today).
export function resolveDashboardWindow({ days, from, to } = {}) {
  const today = startOfUtcDay(new Date());

  if (from && to) {
    const start = startOfUtcDay(new Date(`${from}T00:00:00.000Z`));
    const endDay = startOfUtcDay(new Date(`${to}T00:00:00.000Z`));
    const span = Math.floor((endDay.getTime() - start.getTime()) / DAY_MS) + 1;
    return {
      start,
      endExclusive: new Date(endDay.getTime() + DAY_MS),
      days: span,
      from: ymd(start),
      to: ymd(endDay),
      custom: true,
    };
  }

  const range = DASHBOARD_RANGES.includes(days) ? days : CHART_DAYS;
  const start = new Date(today.getTime() - (range - 1) * DAY_MS);
  return {
    start,
    endExclusive: new Date(today.getTime() + DAY_MS),
    days: range,
    from: ymd(start),
    to: ymd(today),
    custom: false,
  };
}

// Documents per UTC day between start (inclusive) and endExclusive (exclusive).
async function countByDay(Model, dateField, match, start, endExclusive) {
  const rows = await Model.aggregate([
    { $match: { ...match, [dateField]: { $gte: start, $lt: endExclusive } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

// Documents grouped by one field, e.g. { ACTIVE: 120, BANNED: 3 }.
async function countByField(Model, field, match) {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((row) => [row._id ?? 'NONE', row.count]));
}

// Daily sign-ups, matches and messages for each UTC day in the window.
async function buildTrends(start, endExclusive, dayCount) {
  const [signups, matches, messages] = await Promise.all([
    countByDay(User, 'createdAt', { role: 'USER' }, start, endExclusive),
    countByDay(Match, 'createdAt', {}, start, endExclusive),
    countByDay(Message, 'sentAt', {}, start, endExclusive),
  ]);
  return Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10);
    return {
      date,
      signups: signups.get(date) ?? 0,
      matches: matches.get(date) ?? 0,
      messages: messages.get(date) ?? 0,
    };
  });
}

// Percent change vs the previous equal-length window. Null when both sides are zero.
function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? null : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function loadRecentUsers() {
  const docs = await User.find({ role: 'USER' }).sort({ createdAt: -1 }).limit(RECENT_LIMIT).lean();
  const cardFor = await loadUserCards(docs.map((user) => user._id));
  return docs.map((user) => ({
    ...cardFor(user._id),
    email: maskEmail(user.email),
    verificationStatus: user.verificationStatus,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt ?? null,
  }));
}

async function loadRecentReports() {
  const docs = await Report.find().sort({ createdAt: -1 }).limit(RECENT_LIMIT).lean();
  return presentReportSummaries(docs);
}

async function loadRecentVerifications() {
  const docs = await VerificationRequest.find().sort({ createdAt: -1 }).limit(RECENT_LIMIT).lean();
  const cardFor = await loadUserCards(docs.map((request) => request.userId));
  return docs.map((request) => ({
    id: request._id,
    status: request.status,
    user: cardFor(request.userId),
    submittedAt: request.createdAt,
    reviewedAt: request.reviewedAt ?? null,
  }));
}

async function loadRecentMatches() {
  const docs = await Match.find().sort({ createdAt: -1 }).limit(RECENT_LIMIT).lean();
  return docs.map((match) => ({
    id: match._id,
    status: match.status,
    createdAt: match.createdAt,
  }));
}

async function loadRecentTickets() {
  const docs = await SupportTicket.find().sort({ updatedAt: -1 }).limit(RECENT_LIMIT).lean();
  const cardFor = await loadUserCards(docs.map((ticket) => ticket.userId));
  return docs.map((ticket) => ({
    id: ticket._id,
    status: ticket.status,
    subject: ticket.subject,
    category: ticket.category,
    user: cardFor(ticket.userId),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }));
}

const FOLLOW_UP_PRIORITY = { report: 0, verification: 1, photo: 2, ticket: 3, warned: 4 };

function followUpPriority(item) {
  if (item.kind === 'report' && item.reason === 'UNDERAGE') return -1;
  return FOLLOW_UP_PRIORITY[item.kind] ?? 9;
}

function pickFollowUp(current, next) {
  if (!current) return next;
  const currentRank = followUpPriority(current);
  const nextRank = followUpPriority(next);
  if (nextRank < currentRank) return next;
  if (nextRank === currentRank && new Date(next.at) > new Date(current.at)) return next;
  return current;
}

// Members staff should act on next: reports, pending selfies, photo queue, tickets, warnings.
async function loadFollowUp() {
  const [reports, verifications, pendingPhotos, tickets, warnedUsers] = await Promise.all([
    Report.find({ status: { $in: ['OPEN', 'IN_REVIEW'] } }).sort({ updatedAt: -1 }).limit(FOLLOW_UP_LIMIT).lean(),
    VerificationRequest.find({ status: 'PENDING' }).sort({ createdAt: -1 }).limit(FOLLOW_UP_LIMIT).lean(),
    Profile.find({ 'photos.moderationStatus': 'PENDING' }).sort({ updatedAt: -1 }).limit(FOLLOW_UP_LIMIT).lean(),
    SupportTicket.find({ status: { $in: ['OPEN', 'IN_PROGRESS'] } }).sort({ updatedAt: -1 }).limit(FOLLOW_UP_LIMIT).lean(),
    User.find({ role: 'USER', status: 'WARNED' }).sort({ updatedAt: -1 }).limit(FOLLOW_UP_LIMIT).lean(),
  ]);

  const cardFor = await loadUserCards([
    ...reports.map((report) => report.targetUserId),
    ...verifications.map((request) => request.userId),
    ...pendingPhotos.map((profile) => profile.userId),
    ...tickets.map((ticket) => ticket.userId),
    ...warnedUsers.map((user) => user._id),
  ]);

  const candidates = [
    ...reports.map((report) => ({
      id: report._id,
      kind: 'report',
      reason: report.reason,
      badge: report.reason,
      label: 'Open report',
      at: report.updatedAt ?? report.createdAt,
      targetId: report._id,
      user: cardFor(report.targetUserId),
    })),
    ...verifications.map((request) => ({
      id: request._id,
      kind: 'verification',
      reason: 'PENDING_VERIFICATION',
      badge: 'PENDING',
      label: 'Pending selfie',
      at: request.createdAt,
      targetId: request._id,
      user: cardFor(request.userId),
    })),
    ...pendingPhotos.map((profile) => ({
      id: `photo-${profile.userId}`,
      kind: 'photo',
      reason: 'PHOTO_PENDING',
      badge: 'PENDING',
      label: 'Photo pending',
      at: profile.updatedAt ?? profile.createdAt,
      targetId: profile.userId,
      user: cardFor(profile.userId),
    })),
    ...tickets.map((ticket) => ({
      id: ticket._id,
      kind: 'ticket',
      reason: 'OPEN_TICKET',
      badge: ticket.status,
      label: ticket.subject,
      at: ticket.updatedAt ?? ticket.createdAt,
      targetId: ticket._id,
      user: cardFor(ticket.userId),
    })),
    ...warnedUsers.map((user) => ({
      id: `warned-${user._id}`,
      kind: 'warned',
      reason: 'WARNED',
      badge: 'WARNED',
      label: user.statusReason || 'Warned',
      at: user.updatedAt ?? user.createdAt,
      targetId: user._id,
      user: cardFor(user._id),
    })),
  ];

  const byUser = new Map();
  for (const item of candidates) {
    const userId = item.user?.id;
    if (!userId) continue;
    byUser.set(userId, pickFollowUp(byUser.get(userId), item));
  }

  return [...byUser.values()]
    .sort((left, right) => followUpPriority(left) - followUpPriority(right) || new Date(right.at) - new Date(left.at))
    .slice(0, FOLLOW_UP_LIMIT);
}

// GET /admin/dashboard?days=7|30|90 or ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function getDashboard(input = {}) {
  const window = resolveDashboardWindow(input);
  const { start, endExclusive, days: range, from, to } = window;
  const now = new Date();
  const today = startOfUtcDay(now);
  const weekAgo = new Date(now.getTime() - CHART_DAYS * DAY_MS);
  const inRange = { $gte: start, $lt: endExclusive };
  const prevStart = new Date(start.getTime() - range * DAY_MS);
  const prevRange = { $gte: prevStart, $lt: start };
  const members = { role: 'USER' };
  const system = getSystemInfo();

  const [
    totalMembers,
    newToday,
    newLast7Days,
    newInRange,
    newInPrevRange,
    activeLast7Days,
    activeInRange,
    activeInPrevRange,
    onlineNow,
    suspended,
    banned,
    pendingDeletion,
    verifiedMembers,
    pendingVerifications,
    openReports,
    inReviewReports,
    totalReports,
    totalMatches,
    activeMatches,
    matchesToday,
    matchesInRange,
    matchesInPrevRange,
    messagesToday,
    messagesLast7Days,
    messagesInRange,
    messagesInPrevRange,
    openTickets,
    activePremium,
    trends,
    accountStatus,
    verificationStatus,
    reportsByReason,
    recentUsers,
    recentReports,
    recentVerifications,
    recentMatches,
    recentTickets,
    followUp,
  ] = await Promise.all([
    User.countDocuments(members),
    User.countDocuments({ ...members, createdAt: { $gte: today } }),
    User.countDocuments({ ...members, createdAt: { $gte: weekAgo } }),
    User.countDocuments({ ...members, createdAt: inRange }),
    User.countDocuments({ ...members, createdAt: prevRange }),
    User.countDocuments({ ...members, lastActiveAt: { $gte: weekAgo } }),
    User.countDocuments({ ...members, lastActiveAt: inRange }),
    User.countDocuments({ ...members, lastActiveAt: prevRange }),
    Promise.resolve(getOnlineUserCount()),
    User.countDocuments({ ...members, status: 'SUSPENDED' }),
    User.countDocuments({ ...members, status: 'BANNED' }),
    User.countDocuments({ ...members, 'deletion.status': 'SCHEDULED' }),
    User.countDocuments({ ...members, verificationStatus: 'VERIFIED' }),
    VerificationRequest.countDocuments({ status: 'PENDING' }),
    Report.countDocuments({ status: 'OPEN' }),
    Report.countDocuments({ status: 'IN_REVIEW' }),
    Report.countDocuments(),
    Match.countDocuments(),
    Match.countDocuments({ status: 'ACTIVE' }),
    Match.countDocuments({ createdAt: { $gte: today } }),
    Match.countDocuments({ createdAt: inRange }),
    Match.countDocuments({ createdAt: prevRange }),
    Message.countDocuments({ sentAt: { $gte: today } }),
    Message.countDocuments({ sentAt: { $gte: weekAgo } }),
    Message.countDocuments({ sentAt: inRange }),
    Message.countDocuments({ sentAt: prevRange }),
    SupportTicket.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
    SubscriptionEntitlement.countDocuments({ isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    buildTrends(start, endExclusive, range),
    countByField(User, 'status', members),
    countByField(User, 'verificationStatus', members),
    countByField(Report, 'reason', { status: { $in: ['OPEN', 'IN_REVIEW'] } }),
    loadRecentUsers(),
    loadRecentReports(),
    loadRecentVerifications(),
    loadRecentMatches(),
    loadRecentTickets(),
    loadFollowUp(),
  ]);

  const signupsByDay = trends.map((day) => ({ date: day.date, count: day.signups }));
  const changes = {
    newUsers: percentChange(newInRange, newInPrevRange),
    activeUsers: percentChange(activeInRange, activeInPrevRange),
    matches: percentChange(matchesInRange, matchesInPrevRange),
    messages: percentChange(messagesInRange, messagesInPrevRange),
    previous: {
      newUsers: newInPrevRange,
      activeUsers: activeInPrevRange,
      matches: matchesInPrevRange,
      messages: messagesInPrevRange,
    },
  };

  return {
    users: {
      total: totalMembers,
      newToday,
      newLast7Days,
      newInRange,
      activeLast7Days,
      activeInRange,
      onlineNow,
      suspended,
      banned,
      pendingDeletion,
      verified: verifiedMembers,
    },
    moderation: { openReports, inReviewReports, pendingVerifications, totalReports },
    matches: { total: totalMatches, active: activeMatches, createdToday: matchesToday, createdInRange: matchesInRange },
    messages: { sentToday: messagesToday, sentLast7Days: messagesLast7Days, sentInRange: messagesInRange },
    support: { openTickets },
    subscriptions: { activePremium },
    revenue: {
      billingConfigured: system.storeBillingConfigured === true,
      currency: 'INR',
      amount: null,
      activePremium,
      note: system.storeBillingConfigured
        ? null
        : 'Store billing is not configured. There is no payment ledger to sum revenue from.',
    },
    signupsByDay,
    range,
    from,
    to,
    trends,
    changes,
    breakdowns: { accountStatus, verificationStatus, reportsByReason },
    recent: {
      users: recentUsers,
      reports: recentReports,
      verifications: recentVerifications,
      matches: recentMatches,
      tickets: recentTickets,
    },
    followUp,
    generatedAt: now,
  };
}

export { MAX_CUSTOM_DAYS };
