// Safety: blocking and reporting. A block hides both members from each other everywhere, ends
// their match, closes the conversation and stops realtime events between them.

import { Block } from '../models/Block.js';
import { Message } from '../models/Message.js';
import { Profile } from '../models/Profile.js';
import { Report } from '../models/Report.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { loadParticipantConversation } from './chat.service.js';
import { endMatchBetween } from './match.service.js';

// Blocks a member (idempotent) and ends any match between the two.
export async function blockUser(userId, targetUserId) {
  if (userId === targetUserId) throw ApiError.validation([{ field: 'userId', reason: 'INVALID' }]);
  if (!(await User.exists({ _id: targetUserId }))) throw ApiError.notFound();

  await Block.updateOne(
    { blockerId: userId, blockedId: targetUserId },
    { $setOnInsert: { blockerId: userId, blockedId: targetUserId } },
    { upsert: true },
  );
  await endMatchBetween(userId, targetUserId, 'BLOCK', userId);
}

// Removes a block (idempotent). The ended match is not restored.
export async function unblockUser(userId, targetUserId) {
  await Block.deleteOne({ blockerId: userId, blockedId: targetUserId });
}

// Lists the members this member blocked, newest first, with only their id and name.
export async function listBlocks(userId, { limit, cursor }) {
  const docs = await Block.find({ blockerId: userId, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);

  const profiles = await Profile.find({ userId: { $in: page.items.map((block) => block.blockedId) } }).select('userId displayName').lean();
  const nameByUserId = new Map(profiles.map((profile) => [profile.userId, profile.displayName]));
  const items = page.items.map((block) => ({
    user: { id: block.blockedId, displayName: nameByUserId.get(block.blockedId) ?? 'Dating Cloud member' },
    blockedAt: block.createdAt,
  }));
  return { items, nextCursor: page.nextCursor };
}

// Works out which member a report is about. Photos are looked up through the profile that shows them.
async function resolveReportedUserId(targetType, targetId) {
  if (targetType === 'USER') {
    return (await User.exists({ _id: targetId })) ? targetId : null;
  }
  const profile = await Profile.findOne({ 'photos._id': targetId }).select('userId').lean();
  return profile?.userId ?? null;
}

// Saves a report and, when requested (the default), also blocks the reported member.
async function saveReport(reporterId, { targetType, targetId, targetUserId, reason, details, alsoBlock }) {
  const report = await Report.create({
    reporterId,
    targetType,
    targetId,
    targetUserId,
    reason,
    details,
    history: [{ status: 'OPEN', actorId: reporterId, at: new Date() }],
  });
  if (alsoBlock) await blockUser(reporterId, targetUserId);
  return { id: report._id, status: report.status, createdAt: report.createdAt };
}

// POST /reports — reports a member or one of their photos.
export async function reportUserOrPhoto(reporterId, input) {
  const targetUserId = await resolveReportedUserId(input.targetType, input.targetId);
  if (!targetUserId) throw ApiError.notFound();
  if (targetUserId === reporterId) throw ApiError.validation([{ field: 'targetId', reason: 'INVALID' }]);
  return saveReport(reporterId, { ...input, targetUserId });
}

// POST /messages/:messageId/report — reports a message the member received.
export async function reportMessage(reporterId, messageId, input) {
  const message = await Message.findById(messageId);
  if (!message) throw ApiError.notFound();
  await loadParticipantConversation(reporterId, message.conversationId);
  if (message.senderId === reporterId) throw ApiError.validation([{ field: 'messageId', reason: 'CANNOT_REPORT_OWN_MESSAGE' }]);

  return saveReport(reporterId, { ...input, targetType: 'MESSAGE', targetId: messageId, targetUserId: message.senderId });
}
