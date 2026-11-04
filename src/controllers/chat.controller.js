// HTTP handlers for /conversations and /messages.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as chatService from '../services/chat.service.js';
import { validateSendMessage } from '../validators/chat.validator.js';

// GET /conversations — open conversations, most recent first.
export async function getConversations(req, res) {
  return ApiResponse.ok(res, await chatService.listConversations(req.user.id, parsePagination(req.query)));
}

// GET /conversations/:conversationId — one conversation header.
export async function getConversation(req, res) {
  return ApiResponse.ok(res, await chatService.getConversation(req.user.id, req.params.conversationId));
}

// GET /conversations/:conversationId/messages — message history (max 50 per page).
export async function getMessages(req, res) {
  const pagination = parsePagination(req.query, { defaultLimit: 50 });
  return ApiResponse.ok(res, await chatService.listMessages(req.user.id, req.params.conversationId, pagination));
}

// POST /conversations/:conversationId/messages — send a message (idempotent by clientMessageId).
export async function sendMessage(req, res) {
  const input = validateSendMessage(req.body, req.get('Idempotency-Key'));
  return ApiResponse.created(res, await chatService.sendMessage(req.user.id, req.params.conversationId, input));
}

// POST /messages/:messageId/read — mark this and earlier messages read.
export async function markRead(req, res) {
  return ApiResponse.ok(res, await chatService.markMessageRead(req.user.id, req.params.messageId));
}

// DELETE /conversations/:conversationId — hide the chat for the current member only.
export async function deleteConversation(req, res) {
  return ApiResponse.ok(res, await chatService.deleteConversationForMe(req.user.id, req.params.conversationId));
}

// DELETE /messages/:messageId — hide one message for the current member only.
export async function deleteMessage(req, res) {
  return ApiResponse.ok(res, await chatService.deleteMessageForMe(req.user.id, req.params.messageId));
}

// POST /messages/:messageId/unsend — sender unsends for everyone.
export async function unsendMessage(req, res) {
  return ApiResponse.ok(res, await chatService.unsendMessage(req.user.id, req.params.messageId));
}
