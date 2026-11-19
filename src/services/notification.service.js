// Member notifications: inbox entries, preferences, devices, and the push hand-off.
// Inbox rows may include short safe previews for the recipient only. Push stays generic-safe.

import { Device } from '../models/Device.js';
import { Notification } from '../models/Notification.js';
import { NotificationPreference } from '../models/NotificationPreference.js';
import { Profile } from '../models/Profile.js';
import { ApiError } from '../utils/ApiError.js';
import { buildFileUrl } from '../utils/fileUrls.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { sendPushToUser } from './push.service.js';
import { emitToUser } from './realtime.service.js';

const DEFAULT_PREFERENCES = { newMatches: true, messages: true, likes: true, promotions: false };
const PREVIEW_MAX = 120;

// Which preference switches off which notification type (null = always delivered).
const PREFERENCE_BY_TYPE = {
  NEW_MATCH: 'newMatches',
  NEW_MESSAGE: 'messages',
  NEW_LIKE: 'likes',
  VERIFICATION_RESULT: null,
  SYSTEM: null,
};

const UNREAD_FILTER = { $or: [{ readAt: null }, { readAt: { $exists: false } }] };

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

// Truncates text for safe inbox/toast previews.
export function truncatePreview(text, max = PREVIEW_MAX) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}…` : value;
}

// Loads display name + first approved photo URL for notification enrichment.
export async function loadNotificationActor(userId) {
  const profile = await Profile.findOne({ userId }).select('displayName photos').lean();
  const displayName = profile?.displayName || 'Dating Cloud member';
  const approved = [...(profile?.photos || [])]
    .filter((photo) => (photo.moderationStatus ?? 'APPROVED') === 'APPROVED')
    .sort((a, b) => a.order - b.order)[0];
  return {
    displayName,
    photoUrl: approved?.relativePath ? buildFileUrl(approved.relativePath) : '',
  };
}

// Normalizes notification `data` to string values (schema: Map of String).
function sanitizeNotificationData(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

// Notifies a member: stores an inbox entry, optional realtime emit, and push hand-off.
// NEW_MESSAGE rows are deduped by data.messageId when present.
// Mass campaigns should use insertMany and must not call this with emitRealtime for every recipient.
// Returns the inbox entry, or null when skipped by preferences.
export async function notifyUser(
  userId,
  { type, title, body, data = {}, campaignId, isPromotion = false, emitRealtime = true },
) {
  if (!(await wantsNotification(userId, type, isPromotion))) return null;

  const safeData = sanitizeNotificationData(data);
  let notification = null;
  let created = false;

  if (type === 'NEW_MESSAGE' && safeData.messageId) {
    notification = await Notification.findOne({
      userId,
      type: 'NEW_MESSAGE',
      'data.messageId': safeData.messageId,
    });
    if (!notification) {
      notification = await Notification.create({
        userId,
        type,
        title,
        body,
        data: safeData,
        campaignId,
      });
      created = true;
    }
  } else {
    notification = await Notification.create({
      userId,
      type,
      title,
      body,
      data: safeData,
      campaignId,
    });
    created = true;
  }

  const presented = presentNotification(notification);
  if (created && emitRealtime) {
    emitToUser(userId, 'notification:new', { notification: presented });
  }

  await sendPushToUser(userId, { type, title, body, data: safeData });
  return presented;
}

// Shapes an inbox entry for the API.
function presentNotification(notification) {
  const data = notification.data instanceof Map ? Object.fromEntries(notification.data) : (notification.data ?? {});
  return {
    id: notification._id || notification.id,
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
  return presentNotification(notification);
}

// GET /notifications/unread-count — own unread only.
export async function countUnread(userId) {
  const count = await Notification.countDocuments({ userId, ...UNREAD_FILTER });
  return { count };
}

// POST /notifications/read-all — marks every unread notification owned by this member.
export async function markAllRead(userId) {
  const result = await Notification.updateMany(
    { userId, ...UNREAD_FILTER },
    { $set: { readAt: new Date() } },
  );
  return { updated: result.modifiedCount ?? 0 };
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
