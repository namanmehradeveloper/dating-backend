// Cross-cutting analytics for staff: KPIs, period deltas, conversion rates and swipe mix.

import { Match } from '../../models/Match.js';
import { Message } from '../../models/Message.js';
import { Report } from '../../models/Report.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { SupportTicket } from '../../models/SupportTicket.js';
import { LIKE_ACTIONS, Swipe } from '../../models/Swipe.js';
import { User } from '../../models/User.js';
import { DASHBOARD_RANGES, getDashboard } from './adminDashboard.service.js';
import { getSwipeAnalytics } from './adminSwipes.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? null : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

// GET /admin/analytics?days=
export async function getAnalytics({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const now = new Date();
  const since = new Date(now.getTime() - range * DAY_MS);
  const prevSince = new Date(since.getTime() - range * DAY_MS);
  const members = { role: 'USER' };
  const inRange = { $gte: since };
  const prevRange = { $gte: prevSince, $lt: since };

  const [
    dashboard,
    swipeAnalytics,
    dauApprox,
    prevDau,
    newSignups,
    prevNewSignups,
    swipeTotals,
    prevSwipeTotals,
    matchTotals,
    prevMatchTotals,
    messageTotals,
    prevMessageTotals,
    likesInRange,
    matchedLikes,
    premiumActive,
    openReports,
    openTickets,
  ] = await Promise.all([
    getDashboard({ days: range }),
    getSwipeAnalytics({ days: range }),
    User.countDocuments({ ...members, lastActiveAt: inRange }),
    User.countDocuments({ ...members, lastActiveAt: prevRange }),
    User.countDocuments({ ...members, createdAt: inRange }),
    User.countDocuments({ ...members, createdAt: prevRange }),
    Swipe.countDocuments({ createdAt: inRange }),
    Swipe.countDocuments({ createdAt: prevRange }),
    Match.countDocuments({ matchedAt: inRange }),
    Match.countDocuments({ matchedAt: prevRange }),
    Message.countDocuments({ sentAt: inRange }),
    Message.countDocuments({ sentAt: prevRange }),
    Swipe.countDocuments({ createdAt: inRange, action: { $in: LIKE_ACTIONS } }),
    Swipe.countDocuments({ createdAt: inRange, action: { $in: LIKE_ACTIONS }, matchId: { $type: 'string' } }),
    SubscriptionEntitlement.countDocuments({ isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    Report.countDocuments({ status: { $in: ['OPEN', 'IN_REVIEW'] } }),
    SupportTicket.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
  ]);

  const changes = {
    dau: percentChange(dauApprox, prevDau),
    newSignups: percentChange(newSignups, prevNewSignups),
    swipes: percentChange(swipeTotals, prevSwipeTotals),
    matches: percentChange(matchTotals, prevMatchTotals),
    messages: percentChange(messageTotals, prevMessageTotals),
    previous: {
      dau: prevDau,
      newSignups: prevNewSignups,
      swipes: prevSwipeTotals,
      matches: prevMatchTotals,
      messages: prevMessageTotals,
    },
  };

  const rates = {
    swipeToMatch: rate(matchTotals, swipeTotals),
    likeToMatch: rate(matchedLikes, likesInRange),
    messagesPerMatch: matchTotals > 0 ? Math.round((messageTotals / matchTotals) * 10) / 10 : null,
    likesInRange,
    matchedLikes,
  };

  return {
    days: range,
    dauApprox,
    newSignups,
    swipeTotals,
    matchTotals,
    messageTotals,
    premiumActive,
    openReports,
    openTickets,
    changes,
    rates,
    swipeMix: swipeAnalytics.actionMix ?? {},
    swipeSeries: swipeAnalytics.series ?? [],
    recommendationPerformance: swipeAnalytics.recommendationPerformance ?? [],
    dashboard: {
      users: dashboard.users,
      moderation: dashboard.moderation,
      matches: dashboard.matches,
      messages: dashboard.messages,
      support: dashboard.support,
      subscriptions: dashboard.subscriptions,
      trends: dashboard.trends,
      breakdowns: dashboard.breakdowns,
      changes: dashboard.changes,
    },
    generatedAt: now,
  };
}
