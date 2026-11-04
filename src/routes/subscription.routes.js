// Routes for /subscriptions.

import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, HOUR } from '../utils/rateLimit.js';

const router = Router();

const verifyLimit = createRateLimiter({ windowMs: HOUR, max: 20, keyFrom: byUser });
const restoreLimit = createRateLimiter({ windowMs: HOUR, max: 10, keyFrom: byUser });

router.use(requireAuth);

// GET /api/v1/subscriptions/products — paywall products.
router.get('/products', subscriptionController.getProducts);

// GET /api/v1/subscriptions/entitlement — the member's current subscription tier.
router.get('/entitlement', subscriptionController.getEntitlement);

// POST /api/v1/subscriptions/verify — verify a store purchase; returns 501 until store verification is configured (20 per hour).
router.post('/verify', verifyLimit, subscriptionController.verifyPurchase);

// POST /api/v1/subscriptions/restore — restore previous purchases; returns 501 until store verification is configured (10 per hour).
router.post('/restore', restoreLimit, subscriptionController.restorePurchases);

export default router;
