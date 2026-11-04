// Routes for /support and /account (mounted at /api/v1).

import { Router } from 'express';
import * as supportController from '../controllers/support.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, DAY } from '../utils/rateLimit.js';

const router = Router();

const ticketLimit = createRateLimiter({ windowMs: DAY, max: 5, keyFrom: byUser });

// GET /api/v1/support/faqs — FAQ list (public).
router.get('/support/faqs', supportController.getFaqs);

// POST /api/v1/support/tickets — open a support ticket (5 per day).
router.post('/support/tickets', requireAuth, ticketLimit, supportController.createTicket);

// GET /api/v1/support/tickets/:ticketId — one of your own support tickets.
router.get('/support/tickets/:ticketId', requireAuth, supportController.getTicket);

// POST /api/v1/account/deletion-request — schedule account deletion (202 Accepted).
router.post('/account/deletion-request', requireAuth, supportController.requestDeletion);

// GET /api/v1/account/export-status — status of the member's data export.
router.get('/account/export-status', requireAuth, supportController.getExportStatus);

export default router;
