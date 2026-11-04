// Routes for /conversations and /messages (mounted at /api/v1).

import { Router } from 'express';
import * as chatController from '../controllers/chat.controller.js';
import * as safetyController from '../controllers/safety.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireIdempotency } from '../middlewares/idempotency.middleware.js';
import { reportLimit } from './safety.routes.js';
import { byUser, createRateLimiter, HOUR, MINUTE } from '../utils/rateLimit.js';

const router = Router();

const messagesPerConversation = createRateLimiter({
  windowMs: MINUTE,
  max: 30,
  keyFrom: (req) => `${req.user.id}:${req.params.conversationId}`,
});
const messagesPerUser = createRateLimiter({ windowMs: HOUR, max: 300, keyFrom: byUser });

// GET /api/v1/conversations — your open conversations, most recent first.
router.get('/conversations', requireAuth, chatController.getConversations);

// GET /api/v1/conversations/:conversationId — one conversation header.
router.get('/conversations/:conversationId', requireAuth, chatController.getConversation);

// DELETE /api/v1/conversations/:conversationId — hide the chat for the current member only.
router.delete('/conversations/:conversationId', requireAuth, chatController.deleteConversation);

// GET /api/v1/conversations/:conversationId/messages — message history (max 50 per page).
router.get('/conversations/:conversationId/messages', requireAuth, chatController.getMessages);

// POST /api/v1/conversations/:conversationId/messages — send a message
// (idempotent by clientMessageId; 30 per minute per conversation, 300 per hour per member).
router.post(
  '/conversations/:conversationId/messages',
  requireAuth,
  messagesPerConversation,
  messagesPerUser,
  requireIdempotency,
  chatController.sendMessage,
);

// POST /api/v1/messages/:messageId/read — mark this message and all earlier ones as read.
router.post('/messages/:messageId/read', requireAuth, chatController.markRead);

// DELETE /api/v1/messages/:messageId — hide one message for the current member only.
router.delete('/messages/:messageId', requireAuth, chatController.deleteMessage);

// POST /api/v1/messages/:messageId/unsend — sender unsends the message for both members.
router.post('/messages/:messageId/unsend', requireAuth, chatController.unsendMessage);

// POST /api/v1/messages/:messageId/report — report a received message (shares the 20 per day report limit).
router.post('/messages/:messageId/report', requireAuth, reportLimit, safetyController.reportMessage);

export default router;
