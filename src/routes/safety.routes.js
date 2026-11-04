// Routes for /users/:userId/block, /blocks and /reports (mounted at /api/v1).

import { Router } from 'express';
import * as safetyController from '../controllers/safety.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, DAY } from '../utils/rateLimit.js';

const router = Router();

// Shared by POST /reports and POST /messages/:id/report: 20 reports per day per member.
export const reportLimit = createRateLimiter({ windowMs: DAY, max: 20, keyFrom: byUser });

// POST /api/v1/users/:userId/block — block a member (idempotent).
router.post('/users/:userId/block', requireAuth, safetyController.blockUser);

// DELETE /api/v1/users/:userId/block — unblock a member.
router.delete('/users/:userId/block', requireAuth, safetyController.unblockUser);

// GET /api/v1/blocks — members you have blocked.
router.get('/blocks', requireAuth, safetyController.listBlocks);

// POST /api/v1/reports — report a member or photo (20 per day).
router.post('/reports', requireAuth, reportLimit, safetyController.createReport);

export default router;
