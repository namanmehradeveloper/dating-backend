// Routes for /subscriptions.

import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, HOUR } from '../utils/rateLimit.js';

const router = Router();

const checkoutLimit = createRateLimiter({ windowMs: HOUR, max: 30, keyFrom: byUser });
const verifyLimit = createRateLimiter({ windowMs: HOUR, max: 40, keyFrom: byUser });
const restoreLimit = createRateLimiter({ windowMs: HOUR, max: 10, keyFrom: byUser });
const cancelLimit = createRateLimiter({ windowMs: HOUR, max: 10, keyFrom: byUser });

// Public provider webhooks (signature verified inside each adapter).
router.post('/webhooks/:provider', subscriptionController.handleWebhook);

router.use(requireAuth);

router.get('/products', subscriptionController.getProducts);
router.get('/entitlement', subscriptionController.getEntitlement);
router.get('/history', subscriptionController.getHistory);
router.post('/checkout', checkoutLimit, subscriptionController.createCheckout);
router.post('/verify', verifyLimit, subscriptionController.verifyPurchase);
router.post('/restore', restoreLimit, subscriptionController.restorePurchases);
router.post('/cancel', cancelLimit, subscriptionController.cancelSubscription);

export default router;
