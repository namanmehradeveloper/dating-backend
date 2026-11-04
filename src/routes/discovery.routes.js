// Routes for /discovery, /swipes, /likes and /matches (mounted at /api/v1).

import { Router } from 'express';
import * as discoveryController from '../controllers/discovery.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireIdempotency } from '../middlewares/idempotency.middleware.js';
import { byUser, createRateLimiter, MINUTE } from '../utils/rateLimit.js';

const router = Router();
const swipeLimit = createRateLimiter({ windowMs: MINUTE, max: 120, keyFrom: byUser });

// GET /api/v1/discovery — candidate profiles for the swipe deck.
router.get('/discovery', requireAuth, discoveryController.getDiscovery);

// POST /api/v1/swipes — like, pass or super-like a profile (idempotent; 120 per minute).
router.post('/swipes', requireAuth, swipeLimit, requireIdempotency, discoveryController.createSwipe);

// POST /api/v1/swipes/undo — undo the last swipe (premium; 120 per minute).
router.post('/swipes/undo', requireAuth, swipeLimit, discoveryController.undoSwipe);

// GET /api/v1/likes/received — members who liked you (premium; free members get only the count).
router.get('/likes/received', requireAuth, discoveryController.getReceivedLikes);

// GET /api/v1/likes/sent — your pending likes.
router.get('/likes/sent', requireAuth, discoveryController.getSentLikes);

// GET /api/v1/matches — active matches, newest first.
router.get('/matches', requireAuth, discoveryController.getMatches);

// GET /api/v1/matches/:matchId — one match (participants only).
router.get('/matches/:matchId', requireAuth, discoveryController.getMatch);

// POST /api/v1/matches/:matchId/unmatch — end a match.
router.post('/matches/:matchId/unmatch', requireAuth, discoveryController.unmatch);

export default router;
