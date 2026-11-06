import { Router } from 'express';
import * as callController from '../controllers/call.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, MINUTE } from '../utils/rateLimit.js';

const router = Router();
const callStartLimit = createRateLimiter({ windowMs: MINUTE, max: 10, keyFrom: byUser });

router.post('/', requireAuth, callStartLimit, callController.start);
router.get('/active', requireAuth, callController.active);
router.get('/', requireAuth, callController.history);
router.post('/:callId/accept', requireAuth, callController.accept);
router.post('/:callId/reject', requireAuth, callController.reject);
router.post('/:callId/cancel', requireAuth, callController.cancel);
router.post('/:callId/end', requireAuth, callController.end);

export default router;
