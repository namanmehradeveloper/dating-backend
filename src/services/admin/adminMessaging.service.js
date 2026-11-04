// Messaging volume stats and conversation metadata for staff.
// Counts, participants, and last-sender only — never message bodies.

import { Conversation, CONVERSATION_STATUSES } from '../../models/Conversation.js';
import { Match } from '../../models/Match.js';
import { Message } from '../../models/Message.js';
import { Profile } from '../../models/Profile.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { loadUserCards } from './adminPresenter.js';
import { DASHBOARD_RANGES } from './adminDashboard.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_MATCHES = 500;

export { CONVERSATION_STATUSES };

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveConversationSearch(q) {
  if (isValidId(q)) {
    if (q.startsWith('cnv_')) return { conversationId: q };
    if (q.startsWith('mat_')) return { matchId: q };
    return { userIds: [q] };
  }
  const pattern = new RegExp(escapeRegex(q), 'i');
  const nameMatches = await Profile.find({ displayName: pattern }).select('userId').limit(MAX_NAME_MATCHES).lean();
  return { userIds: nameMatches.map((profile) => profile.userId) };
}

async function messageCountsFor(conversationIds) {
  if (conversationIds.length === 0) return new Map();
  const counts = await Message.aggregate([
    { $match: { conversationId: { $in: conversationIds } } },
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((entry) => [entry._id, entry.count]));
}

// Loads last-message metadata only (sender + flags). Never selects `text`.
async function lastMessageMetaFor(messageIds) {
  const ids = messageIds.filter(Boolean);
  if (ids.length === 0) return new Map();
  const docs = await Message.find({ _id: { $in: ids } })
    .select('_id senderId sentAt attachment')
    .lean();
  return new Map(
    docs.map((doc) => [
      doc._id,
      {
        senderId: doc.senderId,
        sentAt: doc.sentAt,
        hasAttachment: Boolean(doc.attachment?.mediaId),
      },
    ]),
  );
}

// GET /admin/messaging/stats?days=
export async function getMessagingStats({ days } = {}) {
  const range = DASHBOARD_RANGES.includes(days) ? days : 7;
  const since = new Date(Date.now() - range * DAY_MS);

  const activeMatches = await Match.find({ status: 'ACTIVE' }).select('conversationId').lean();
  const conversationIds = activeMatches.map((match) => match.conversationId).filter(Boolean);

  const [conversationCount, messageCount, activeConversations, messagesOnActiveMatches] = await Promise.all([
    Conversation.countDocuments({ createdAt: { $gte: since } }),
    Message.countDocuments({ sentAt: { $gte: since } }),
    Conversation.countDocuments({ status: 'ACTIVE' }),
    conversationIds.length
      ? Message.countDocuments({ conversationId: { $in: conversationIds } })
      : Promise.resolve(0),
  ]);

  const avgMessagesPerActiveMatch =
    activeMatches.length > 0 ? Math.round((messagesOnActiveMatches / activeMatches.length) * 10) / 10 : 0;

  return {
    days: range,
    conversationCount,
    messageCount,
    activeConversations,
    avgMessagesPerActiveMatch,
  };
}

// GET /admin/messaging/conversations — who ↔ whom, counts, last sender. No message text.
export async function listConversations(filters, { limit, cursor }) {
  const query = {};
  if (filters.status) query.status = filters.status;

  if (filters.q) {
    const resolved = await resolveConversationSearch(filters.q);
    if (resolved.conversationId) query._id = resolved.conversationId;
    else if (resolved.matchId) query.matchId = resolved.matchId;
    else if (resolved.userIds?.length) query.participantIds = { $in: resolved.userIds };
    else return { items: [], nextCursor: null };
  }

  const docs = await Conversation.find({ ...query, ...getAfterCursorFilter(cursor, 'lastActivityAt') })
    .sort(getPageSort('lastActivityAt'))
    .limit(limit + 1)
    .lean();

  const page = buildPage(docs, limit, 'lastActivityAt');
  const conversationIds = page.items.map((row) => row._id);
  const [countByConversation, lastById, cardFor] = await Promise.all([
    messageCountsFor(conversationIds),
    lastMessageMetaFor(page.items.map((row) => row.lastMessageId)),
    loadUserCards(page.items.flatMap((row) => row.participantIds)),
  ]);

  const items = page.items.map((conversation) => {
    const last = conversation.lastMessageId ? lastById.get(conversation.lastMessageId) : null;
    const participants = conversation.participantIds.map((id) => cardFor(id));
    const [memberA, memberB] = participants;

    return {
      id: conversation._id,
      matchId: conversation.matchId,
      status: conversation.status,
      memberA: memberA ?? null,
      memberB: memberB ?? null,
      participants,
      messageCount: countByConversation.get(conversation._id) ?? 0,
      lastActivityAt: conversation.lastActivityAt ?? conversation.updatedAt ?? conversation.createdAt,
      lastSender: last?.senderId ? cardFor(last.senderId) : null,
      lastMessageAt: last?.sentAt ?? null,
      lastHadAttachment: last?.hasAttachment ?? false,
      closedAt: conversation.closedAt ?? null,
      createdAt: conversation.createdAt,
    };
  });

  return { items, nextCursor: page.nextCursor };
}
