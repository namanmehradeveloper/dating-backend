// Routes for /devices, /notifications and /notification-preferences (mounted at /api/v1).

import { Router } from 'express';
import * as notificationController from '../controllers/notification.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

// POST /api/v1/devices — register a push token or move it to this member.
router.post('/devices', requireAuth, notificationController.registerDevice);

// DELETE /api/v1/devices/:deviceId — stop push notifications to a device.
router.delete('/devices/:deviceId', requireAuth, notificationController.removeDevice);

// GET /api/v1/notifications — notification inbox, newest first.
router.get('/notifications', requireAuth, notificationController.listNotifications);

// POST /api/v1/notifications/:notificationId/read — mark one notification as read.
router.post('/notifications/:notificationId/read', requireAuth, notificationController.markRead);

// GET /api/v1/notification-preferences — the member's notification settings.
router.get('/notification-preferences', requireAuth, notificationController.getPreferences);

// PATCH /api/v1/notification-preferences — partial update of notification settings.
router.patch('/notification-preferences', requireAuth, notificationController.updatePreferences);

export default router;
