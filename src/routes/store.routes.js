// Routes for /store — virtual gifts, paid emoji packs, and coin wallet.

import { Router } from 'express';
import * as storeController from '../controllers/store.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, HOUR } from '../utils/rateLimit.js';

const router = Router();

const checkoutLimit = createRateLimiter({ windowMs: HOUR, max: 40, keyFrom: byUser });
const verifyLimit = createRateLimiter({ windowMs: HOUR, max: 60, keyFrom: byUser });
const buyLimit = createRateLimiter({ windowMs: HOUR, max: 60, keyFrom: byUser });

router.use(requireAuth);

router.get('/catalog', storeController.getCatalog);
router.get('/wallet', storeController.getWallet);
router.get('/history', storeController.getHistory);
router.post('/checkout', checkoutLimit, storeController.createCheckout);
router.post('/verify', verifyLimit, storeController.verifyPurchase);
router.post('/buy-with-coins', buyLimit, storeController.buyWithCoins);

export default router;
