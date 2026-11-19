// Routes for /support and /account (mounted at /api/v1).

import { Router } from 'express';
import * as supportController from '../controllers/support.controller.js';
import { optionalAuth, requireAuth } from '../middlewares/auth.middleware.js';
import { requireIdempotency } from '../middlewares/idempotency.middleware.js';
import { byUser, createRateLimiter, HOUR } from '../utils/rateLimit.js';

const router = Router();

// Member follow-ups: soft anti-spam. Creates use MongoDB atomic daily quota instead.
const memberReplyLimit = createRateLimiter({ windowMs: HOUR, max: 30, keyFrom: byUser });

// GET /api/v1/support/faqs — FAQ list (public).
router.get('/support/faqs', supportController.getFaqs);

// POST /api/v1/support/tickets — open a support ticket (auth optional; Idempotency-Key required).
// Daily limit (5/user or 5/IP) is enforced atomically in support.service — not memory rate-limit.
router.post(
  '/support/tickets',
  optionalAuth,
  requireIdempotency,
  supportController.createTicket,
);

// GET /api/v1/support/tickets — authenticated member's own tickets (must be before :ticketId).
router.get('/support/tickets', requireAuth, supportController.listTickets);

// GET /api/v1/support/tickets/:ticketId — one of your own support tickets.
router.get('/support/tickets/:ticketId', requireAuth, supportController.getTicket);

// POST /api/v1/support/tickets/:ticketId/messages — owner follow-up (Idempotency-Key + 30/hour).
router.post(
  '/support/tickets/:ticketId/messages',
  requireAuth,
  requireIdempotency,
  memberReplyLimit,
  supportController.replyToTicket,
);

// POST /api/v1/account/deletion-request — schedule account deletion (202 Accepted).
router.post('/account/deletion-request', requireAuth, supportController.requestDeletion);

// GET /api/v1/account/export-status — status of the member's data export.
router.get('/account/export-status', requireAuth, supportController.getExportStatus);

export default router;
