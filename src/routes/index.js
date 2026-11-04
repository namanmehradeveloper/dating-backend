// Mounts every feature router under /api/v1 (the prefix is added in app.js).

import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import profileRoutes from './profile.routes.js';
import mediaRoutes from './media.routes.js';
import discoveryRoutes from './discovery.routes.js';
import chatRoutes from './chat.routes.js';
import safetyRoutes from './safety.routes.js';
import notificationRoutes from './notification.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import supportRoutes from './support.routes.js';
import adminRoutes from './admin.routes.js';
import * as profileController from '../controllers/profile.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

// /api/v1/health — server and database health check.
router.use('/health', healthRoutes);

// /api/v1/auth — OTP, email/password, social sign-in, token refresh and logout.
router.use('/auth', authRoutes);

// /api/v1/profile — the signed-in member's own profile, preferences, interests, photos and verification.
router.use('/profile', profileRoutes);

// GET /api/v1/profiles/:userId — another member's public profile (signed-in).
router.get('/profiles/:userId', requireAuth, profileController.getPublicProfile);

// GET /api/v1/interests — the interest catalogue (signed-in).
router.get('/interests', requireAuth, profileController.getInterests);

// /api/v1/media — image upload and media metadata.
router.use('/media', mediaRoutes);

// /api/v1/discovery, /swipes, /likes, /matches — swipe deck, likes and matches.
router.use(discoveryRoutes);

// /api/v1/conversations, /messages — chat.
router.use(chatRoutes);

// /api/v1/users/:userId/block, /blocks, /reports — blocking and reporting.
router.use(safetyRoutes);

// /api/v1/devices, /notifications, /notification-preferences — push devices and notification inbox.
router.use(notificationRoutes);

// /api/v1/subscriptions — paywall products, entitlement and store purchases.
router.use('/subscriptions', subscriptionRoutes);

// /api/v1/support, /account — FAQs, support tickets, account deletion and data export.
router.use(supportRoutes);

// /api/v1/admin — admin panel (MODERATOR / ADMIN only).
router.use('/admin', adminRoutes);

export default router;
