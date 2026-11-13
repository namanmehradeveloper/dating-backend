// Chat over REST, the source of truth for messages. Socket.IO events (message:new, message:read)
// are only sent after the database write succeeded, and only while the match is active,
// neither member blocked the other, and both accounts are usable.

import { Conversation } from '../models/Conversation.js';
import { Media } from '../models/Media.js';
import { Message } from '../models/Message.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildFileUrl } from '../utils/fileUrls.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { isVisibleMember } from './accountStatus.service.js';
import { getBlockedUserIds, hasBlocked, isBlockedEitherWay } from './block.service.js';
import { notifyUser } from './notification.service.js';
import { toPublicProfiles } from './profilePresenter.js';
import { allowsOnlineStatus, resolveVisiblePresence } from './presence.service.js';
import { emitToUser } from './realtime.service.js';

// Returns the other participant of a two-person conversation.
export function otherParticipant(conversation, userId) {
  return conversation.participantIds.find((id) => id !== userId);
}

// Shapes a message photo for the API with a fresh signed URL (valid one hour), or null when there is none.
export function presentAttachment(attachment) {
  if (!attachment?.mediaId) return null;
  return {
    mediaId: attachment.mediaId,
    url: buildFileUrl(attachment.relativePath),
    contentType: attachment.contentType,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
  };
}

// Shapes a message for the API. Status is UNSENT after delete-for-everyone, READ once the
// recipient has read it, otherwise SENT.
export function presentMessage(message) {
  const unsent = Boolean(message.unsentAt);
  const presented = {
    id: message._id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    text: unsent ? '' : (message.text ?? ''),
    attachment: unsent ? null : presentAttachment(message.attachment),
    sentAt: message.sentAt,
    status: unsent ? 'UNSENT' : message.readAt ? 'READ' : 'SENT',
    clientMessageId: message.clientMessageId ?? null,
  };
  if (unsent) presented.unsentAt = message.unsentAt;
  return presented;
}

// True when this viewer has hidden the conversation ("Delete chat").
function isConversationHiddenFor(conversation, userId) {
  return Array.isArray(conversation.hiddenFor) && conversation.hiddenFor.includes(userId);
}

// Loads a conversation the member takes part in. Anyone else gets 404.
export async function loadParticipantConversation(userId, conversationId) {
  const conversation = await Conversation.findOne({ _id: conversationId, participantIds: userId });
  if (!conversation) throw ApiError.notFound();
  return conversation;
}

// Same as loadParticipantConversation, but conversations the member deleted are treated as gone.
async function loadVisibleConversation(userId, conversationId) {
  const conversation = await loadParticipantConversation(userId, conversationId);
  if (isConversationHiddenFor(conversation, userId)) throw ApiError.notFound();
  return conversation;
}

// Newest message in the thread that this viewer has not hidden (for list previews).
async function resolveLastMessageForViewer(conversationId, lastMessageId, viewerId) {
  if (!lastMessageId) return null;
  const lastMessage = await Message.findById(lastMessageId).lean();
  if (lastMessage && !(lastMessage.hiddenFor || []).includes(viewerId)) return lastMessage;
  return Message.findOne({ conversationId, hiddenFor: { $ne: viewerId } }).sort({ sentAt: -1, _id: -1 }).lean();
}

// Returns true when realtime chat events may flow: the conversation is open, nobody is blocked,
// and both members' accounts are usable.
export async function canDeliverChatEvents(conversation) {
  if (conversation.status !== 'ACTIVE') return false;
  const [first, second] = conversation.participantIds;
  if (await isBlockedEitherWay(first, second)) return false;
  const users = await User.find({ _id: { $in: conversation.participantIds } });
  return users.length === 2 && users.every(isVisibleMember);
}

// Throws the documented chat errors: USER_BLOCKED when the member blocked the other person,
// MATCH_REQUIRED when the match ended, the other member blocked them, or the other account is hidden.
async function assertCanChat(conversation, userId) {
  const otherId = otherParticipant(conversation, userId);
  if (await hasBlocked(userId, otherId)) throw new ApiError('USER_BLOCKED');
  if (!(await canDeliverChatEvents(conversation))) throw new ApiError('MATCH_REQUIRED');
}

// Builds conversation summaries with the other member, last message and unread count.
async function presentConversations(conversations, viewerId) {
  const otherIds = conversations.map((conversation) => otherParticipant(conversation, viewerId));

  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: otherIds } }).lean(),
    Profile.find({ userId: { $in: otherIds } }).lean(),
  ]);
  const usersById = new Map(users.map((user) => [user._id, user]));
  const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
  const publicProfiles = await toPublicProfiles(profiles, usersById);
  const profileById = new Map(publicProfiles.map((profile) => [profile.id, profile]));

  const summaries = [];
  for (const conversation of conversations) {
    const otherId = otherParticipant(conversation, viewerId);
    if (!isVisibleMember(usersById.get(otherId)) || !profileById.has(otherId)) continue;

    const lastMessage = await resolveLastMessageForViewer(conversation._id, conversation.lastMessageId, viewerId);
    const unreadCount = await Message.countDocuments({
      conversationId: conversation._id,
      senderId: otherId,
      readAt: null,
      unsentAt: null,
      hiddenFor: { $ne: viewerId },
    });
    const otherProfile = profilesByUserId.get(otherId);
    const presence = resolveVisiblePresence({
      userId: otherId,
      user: usersById.get(otherId),
      showOnlineStatus: allowsOnlineStatus(otherProfile),
    });
    summaries.push({
      id: conversation._id,
      matchId: conversation.matchId,
      otherUser: {
        ...profileById.get(otherId),
        isOnline: presence.isOnline,
        lastSeenAt: presence.lastSeenAt,
      },
      lastMessage: lastMessage ? presentMessage(lastMessage) : null,
      unreadCount,
    });
  }
  return summaries;
}

// Lists the member's open conversations, most recent activity first.
export async function listConversations(userId, { limit, cursor }) {
  const blockedIds = await getBlockedUserIds(userId);
  const participantFilter = blockedIds.length > 0 ? { $eq: userId, $nin: blockedIds } : userId;
  const filter = {
    participantIds: participantFilter,
    status: 'ACTIVE',
    hiddenFor: { $ne: userId },
    ...getAfterCursorFilter(cursor, 'lastActivityAt'),
  };

  const docs = await Conversation.find(filter).sort(getPageSort('lastActivityAt')).limit(limit + 1).lean();
  const page = buildPage(docs, limit, 'lastActivityAt');
  return { items: await presentConversations(page.items, userId), nextCursor: page.nextCursor };
}

// Returns one open conversation to a participant (404 for anyone else, or when it is closed or hidden).
export async function getConversation(userId, conversationId) {
  const conversation = await loadVisibleConversation(userId, conversationId);
  if (!(await canDeliverChatEvents(conversation))) throw ApiError.notFound();
  const [summary] = await presentConversations([conversation.toObject()], userId);
  if (!summary) throw ApiError.notFound();
  return summary;
}

// Returns one page of messages, oldest first within the page; nextCursor loads older messages.
export async function listMessages(userId, conversationId, { limit, cursor }) {
  const conversation = await loadVisibleConversation(userId, conversationId);
  await assertCanChat(conversation, userId);

  const docs = await Message.find({
    conversationId,
    hiddenFor: { $ne: userId },
    ...getAfterCursorFilter(cursor, 'sentAt'),
  })
    .sort(getPageSort('sentAt'))
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit, 'sentAt');
  return { items: page.items.reverse().map(presentMessage), nextCursor: page.nextCursor };
}

// Loads a photo the sender uploaded for chat (purpose CHAT_ATTACHMENT, not deleted) and returns the
// details stored on the message. Someone else's media or a profile photo counts as unknown.
async function loadChatAttachment(senderId, mediaId) {
  const media = await Media.findOne({ _id: mediaId, ownerId: senderId, purpose: 'CHAT_ATTACHMENT', status: 'APPROVED' }).lean();
  if (!media) throw ApiError.validation([{ field: 'attachmentMediaId', reason: 'UNKNOWN_MEDIA' }]);
  return {
    mediaId: media._id,
    relativePath: media.relativePath,
    contentType: media.contentType,
    width: media.width,
    height: media.height,
  };
}

// Saves a message once per clientMessageId; a retried send returns the message already saved.
async function saveMessage(conversationId, senderId, { text, attachment, clientMessageId }) {
  const existing = await Message.findOne({ senderId, clientMessageId });
  if (existing) return { message: existing, isNew: false };

  try {
    const message = await Message.create({ conversationId, senderId, text, attachment, clientMessageId, sentAt: new Date() });
    return { message, isNew: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { message: await Message.findOne({ senderId, clientMessageId }), isNew: false };
  }
}

// Sends a message (text, an uploaded chat photo, or both): checks membership, the active match and
// blocks, saves it, then announces it with message:new to both members and a content-free push to the recipient.
export async function sendMessage(userId, conversationId, { text, attachmentMediaId, clientMessageId }) {
  const conversation = await loadParticipantConversation(userId, conversationId);
  await assertCanChat(conversation, userId);

  const attachment = attachmentMediaId ? await loadChatAttachment(userId, attachmentMediaId) : null;
  const { message, isNew } = await saveMessage(conversationId, userId, { text, attachment, clientMessageId });
  if (message.conversationId !== conversationId) {
    throw ApiError.conflict('This clientMessageId was already used in another conversation.');
  }

  const presented = presentMessage(message);
  if (isNew) {
    // A new message brings the chat back for anyone who had deleted it for themselves.
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: { lastMessageId: message._id, lastActivityAt: message.sentAt },
        $pull: { hiddenFor: { $in: conversation.participantIds } },
      },
    );
    const recipientId = otherParticipant(conversation, userId);
    for (const participantId of conversation.participantIds) {
      emitToUser(participantId, 'message:new', { message: presented });
    }
    await notifyUser(recipientId, {
      type: 'NEW_MESSAGE',
      title: 'New message',
      body: 'You have a new message.',
      data: { conversationId },
    });
  }
  return presented;
}

// DELETE /conversations/:conversationId — hides the chat for the current member only.
export async function deleteConversationForMe(userId, conversationId) {
  const conversation = await loadParticipantConversation(userId, conversationId);
  await Conversation.updateOne({ _id: conversationId }, { $addToSet: { hiddenFor: userId } });
  const payload = { conversationId };
  emitToUser(userId, 'conversation:deleted', payload);
  return payload;
}

// DELETE /messages/:messageId — hides one message for the current member only.
export async function deleteMessageForMe(userId, messageId) {
  const message = await Message.findById(messageId);
  if (!message) throw ApiError.notFound();
  const conversation = await loadParticipantConversation(userId, message.conversationId);
  if (isConversationHiddenFor(conversation, userId)) throw ApiError.notFound();

  await Message.updateOne({ _id: messageId }, { $addToSet: { hiddenFor: userId } });
  const payload = { conversationId: message.conversationId, messageId: message._id, scope: 'ME' };
  emitToUser(userId, 'message:deleted', payload);
  return payload;
}

// POST /messages/:messageId/unsend — sender clears the message for both members.
export async function unsendMessage(userId, messageId) {
  const message = await Message.findById(messageId);
  if (!message) throw ApiError.notFound();
  if (message.senderId !== userId) throw ApiError.notFound();

  const conversation = await loadParticipantConversation(userId, message.conversationId);
  if (isConversationHiddenFor(conversation, userId)) throw ApiError.notFound();

  if (!message.unsentAt) {
    message.text = '';
    message.attachment = null;
    message.unsentAt = new Date();
    message.unsentBy = userId;
    await message.save();
  }

  const presented = presentMessage(message);
  const payload = { conversationId: message.conversationId, messageId: message._id, message: presented };
  if (await canDeliverChatEvents(conversation)) {
    for (const participantId of conversation.participantIds) {
      emitToUser(participantId, 'message:unsent', payload);
    }
  } else {
    emitToUser(userId, 'message:unsent', payload);
  }
  return presented;
}

// Marks every incoming message up to `upToMessage` as read and emits message:read.
// Only the recipient may do this: the sender of `upToMessage` gets 404, same as an outsider.
async function markReadUpTo(userId, conversation, upToMessage) {
  if (upToMessage.senderId === userId) throw ApiError.notFound();

  const readAt = new Date();
  const otherId = otherParticipant(conversation, userId);

  await Message.updateMany(
    { conversationId: conversation._id, senderId: otherId, sentAt: { $lte: upToMessage.sentAt }, readAt: null },
    { $set: { readAt } },
  );
  await Conversation.updateOne(
    { _id: conversation._id, 'readStates.userId': userId },
    { $set: { 'readStates.$.lastReadAt': readAt, 'readStates.$.lastReadMessageId': upToMessage._id } },
  );

  const payload = { conversationId: conversation._id, readerId: userId, upToMessageId: upToMessage._id, readAt };
  if (await canDeliverChatEvents(conversation)) {
    for (const participantId of conversation.participantIds) {
      emitToUser(participantId, 'message:read', payload);
    }
  }
  return payload;
}

// POST /messages/:messageId/read — marks this and earlier received messages as read.
export async function markMessageRead(userId, messageId) {
  const message = await Message.findById(messageId);
  if (!message) throw ApiError.notFound();
  const conversation = await loadParticipantConversation(userId, message.conversationId);
  return markReadUpTo(userId, conversation, message);
}

// Socket "message:read": the same as the REST call, addressed by conversation and message id.
export async function markConversationRead(userId, conversationId, upToMessageId) {
  const conversation = await loadParticipantConversation(userId, conversationId);
  const message = await Message.findOne({ _id: upToMessageId, conversationId });
  if (!message) throw ApiError.notFound();
  return markReadUpTo(userId, conversation, message);
}

// Checks that a member may send a typing indicator in a conversation (participant, active, not blocked).
export async function assertCanSendTyping(userId, conversationId) {
  const conversation = await loadParticipantConversation(userId, conversationId);
  if (!(await canDeliverChatEvents(conversation))) throw new ApiError('MATCH_REQUIRED');
  return conversation;
}
