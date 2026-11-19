// Routes for /support and /account (mounted at /api/v1).

import { Router } from 'express';
import * as supportController from '../controllers/support.controller.js';
import { optionalAuth, requireAuth } from '../middlewares/auth.middleware.js';
import { byIp, byUser, createRateLimiter, DAY, HOUR } from '../utils/rateLimit.js';

const router = Router();

const memberTicketLimit = createRateLimiter({ windowMs: DAY, max: 5, keyFrom: byUser });
const guestTicketLimit = createRateLimiter({ windowMs: DAY, max: 5, keyFrom: byIp });
const memberReplyLimit = createRateLimiter({ windowMs: HOUR, max: 30, keyFrom: byUser });

// Auth members: 5/day per user. Guests: 5/day per IP.
function ticketCreateLimit(req, res, next) {
  if (req.user?.id) return memberTicketLimit(req, res, next);
  return guestTicketLimit(req, res, next);
}

// GET /api/v1/support/faqs — FAQ list (public).
router.get('/support/faqs', supportController.getFaqs);

// POST /api/v1/support/tickets — open a support ticket (auth optional; 5 per day).
router.post('/support/tickets', optionalAuth, ticketCreateLimit, supportController.createTicket);

// GET /api/v1/support/tickets — authenticated member's own tickets (must be before :ticketId).
router.get('/support/tickets', requireAuth, supportController.listTickets);

// GET /api/v1/support/tickets/:ticketId — one of your own support tickets.
router.get('/support/tickets/:ticketId', requireAuth, supportController.getTicket);

// POST /api/v1/support/tickets/:ticketId/messages — owner follow-up (30/hour).
router.post(
  '/support/tickets/:ticketId/messages',
  requireAuth,
  memberReplyLimit,
  supportController.replyToTicket,
);

// POST /api/v1/account/deletion-request — schedule account deletion (202 Accepted).
router.post('/account/deletion-request', requireAuth, supportController.requestDeletion);

// GET /api/v1/account/export-status — status of the member's data export.
router.get('/account/export-status', requireAuth, supportController.getExportStatus);

export default router;
