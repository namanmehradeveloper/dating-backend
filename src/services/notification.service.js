// Member notifications: inbox entries, preferences, devices, and the push hand-off.
// Texts are generic on purpose ("You have a new message"), never message content or location.

import { Device } from '../models/Device.js';
import { Notification } from '../models/Notification.js';
import { NotificationPreference } from '../models/NotificationPreference.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { sendPushToUser } from './push.service.js';

const DEFAULT_PREFERENCES = { newMatches: true, messages: true, likes: true, promotions: false };

// Which preference switches off which notification type (null = always delivered).
const PREFERENCE_BY_TYPE = {
  NEW_MATCH: 'newMatches',
  NEW_MESSAGE: 'messages',
  NEW_LIKE: 'likes',
  VERIFICATION_RESULT: null,
  SYSTEM: null,
};

// Returns a member's preferences, using the defaults when they never changed them.
export async function getPreferences(userId) {
  const stored = await NotificationPreference.findOne({ userId }).lean();
  return {
    newMatches: stored?.newMatches ?? DEFAULT_PREFERENCES.newMatches,
    messages: stored?.messages ?? DEFAULT_PREFERENCES.messages,
    likes: stored?.likes ?? DEFAULT_PREFERENCES.likes,
    promotions: stored?.promotions ?? DEFAULT_PREFERENCES.promotions,
  };
}

// Saves a partial preference update and returns the full preferences.
export async function updatePreferences(userId, changes) {
  await NotificationPreference.findOneAndUpdate({ userId }, { $set: changes }, { upsert: true });
  return getPreferences(userId);
}

// Returns true when the member wants this kind of notification.
async function wantsNotification(userId, type, isPromotion) {
  const preferences = await getPreferences(userId);
  if (isPromotion) return preferences.promotions;
  const preferenceKey = PREFERENCE_BY_TYPE[type];
  return preferenceKey ? preferences[preferenceKey] : true;
}

// Notifies a member: stores an inbox entry (except for chat messages, which have their own
// unread counts) and hands the notification to push. Returns the inbox entry, or null when skipped.
export async function notifyUser(userId, { type, title, body, data = {}, campaignId, isPromotion = false }) {
  if (!(await wantsNotification(userId, type, isPromotion))) return null;

  let notification = null;
  if (type !== 'NEW_MESSAGE') {
    notification = await Notification.create({ userId, type, title, body, data, campaignId });
  }
  await sendPushToUser(userId, { type, title, body, data });
  return notification;
}

// Shapes an inbox entry for the API.
function presentNotification(notification) {
  const data = notification.data instanceof Map ? Object.fromEntries(notification.data) : (notification.data ?? {});
  return {
    id: notification._id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data,
    createdAt: notification.createdAt,
    readAt: notification.readAt ?? null,
  };
}

// Returns one page of the member's inbox, newest first.
export async function listNotifications(userId, { limit, cursor }) {
  const docs = await Notification.find({ userId, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  return { items: page.items.map(presentNotification), nextCursor: page.nextCursor };
}

// Marks one of the member's notifications as read. Other members' notifications are 404.
export async function markNotificationRead(userId, notificationId) {
  const notification = await Notification.findOne({ _id: notificationId, userId });
  if (!notification) throw ApiError.notFound();
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }
}

// Registers (or moves) a push token to this member's device list.
export async function registerDevice(userId, { platform, pushToken, appVersion, locale }) {
  const device = await Device.findOneAndUpdate(
    { pushToken },
    { $set: { userId, platform, appVersion, locale, lastSeenAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  return { id: device._id, platform: device.platform, lastSeenAt: device.lastSeenAt };
}

// Removes one of the member's devices so it stops receiving pushes.
export async function removeDevice(userId, deviceId) {
  const result = await Device.deleteOne({ _id: deviceId, userId });
  if (result.deletedCount === 0) throw ApiError.notFound();
}
