// HTTP handlers for push devices, the notification inbox and notification preferences.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as notificationService from '../services/notification.service.js';
import { validateDevice, validatePreferenceUpdate } from '../validators/notification.validator.js';

// POST /devices — register or move a push token.
export async function registerDevice(req, res) {
  const device = validateDevice(req.body);
  return ApiResponse.ok(res, await notificationService.registerDevice(req.user.id, device));
}

// DELETE /devices/:deviceId — stop pushes to a device.
export async function removeDevice(req, res) {
  await notificationService.removeDevice(req.user.id, req.params.deviceId);
  return ApiResponse.ok(res, null);
}

// GET /notifications — inbox, newest first.
export async function listNotifications(req, res) {
  return ApiResponse.ok(res, await notificationService.listNotifications(req.user.id, parsePagination(req.query)));
}

// POST /notifications/:notificationId/read — mark one notification read.
export async function markRead(req, res) {
  await notificationService.markNotificationRead(req.user.id, req.params.notificationId);
  return ApiResponse.ok(res, null);
}

// GET /notification-preferences
export async function getPreferences(req, res) {
  return ApiResponse.ok(res, await notificationService.getPreferences(req.user.id));
}

// PATCH /notification-preferences — partial update.
export async function updatePreferences(req, res) {
  const changes = validatePreferenceUpdate(req.body);
  return ApiResponse.ok(res, await notificationService.updatePreferences(req.user.id, changes));
}
