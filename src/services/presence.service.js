// Member presence for chat: online while any socket is connected, lastSeen when they go offline.
// Broadcasts user:online, user:offline and presence:update to active conversation partners.
// Respects Profile.privacy.showOnlineStatus (default true).

import { Conversation } from '../models/Conversation.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { getBlockedUserIds } from './block.service.js';
import {
  emitToUser,
  getCachedLastSeenAt,
  isUserOnline,
} from './realtime.service.js';
import { logger } from '../utils/logger.js';

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// True when the member allows others to see their online / last-seen status.
export function allowsOnlineStatus(profile) {
  return profile?.privacy?.showOnlineStatus !== false;
}

// Visible presence for a viewer looking at subjectId. Uses already-loaded user/profile when provided.
export function resolveVisiblePresence({ userId, user = null, showOnlineStatus = true }) {
  if (!showOnlineStatus) {
    return { isOnline: false, lastSeenAt: null };
  }

  if (isUserOnline(userId)) {
    return { isOnline: true, lastSeenAt: null };
  }

  const lastSeenAt = toIso(getCachedLastSeenAt(userId) ?? user?.lastActiveAt ?? null);
  return { isOnline: false, lastSeenAt };
}

// Builds the socket/API presence payload after applying privacy.
export function buildPresencePayload(userId, { isOnline, lastSeenAt = null, reveal = true }) {
  if (!reveal) {
    return { userId, isOnline: false, lastSeenAt: null };
  }
  return {
    userId,
    isOnline: Boolean(isOnline),
    lastSeenAt: isOnline ? null : toIso(lastSeenAt),
  };
}

// Active chat partners who should receive this member's presence updates.
async function findPresenceRecipients(userId) {
  const [conversations, blockedIds] = await Promise.all([
    Conversation.find({ participantIds: userId, status: 'ACTIVE' }).select('participantIds').lean(),
    getBlockedUserIds(userId),
  ]);
  const blocked = new Set(blockedIds);
  const recipients = new Set();

  for (const conversation of conversations) {
    for (const participantId of conversation.participantIds) {
      if (participantId === userId || blocked.has(participantId)) continue;
      recipients.add(participantId);
    }
  }
  return [...recipients];
}

async function loadRevealFlag(userId) {
  const profile = await Profile.findOne({ userId }).select('privacy').lean();
  return allowsOnlineStatus(profile);
}

// Persists lastSeen on the user document when they leave their last device.
export async function persistLastSeen(userId, lastSeenAt) {
  if (!lastSeenAt) return;
  await User.updateOne({ _id: userId }, { $set: { lastActiveAt: lastSeenAt } });
}

// Emits presence events to every eligible conversation partner.
export async function broadcastPresence(userId, { isOnline, lastSeenAt = null }) {
  try {
    const reveal = await loadRevealFlag(userId);
    const payload = buildPresencePayload(userId, { isOnline, lastSeenAt, reveal });
    const recipients = await findPresenceRecipients(userId);

    for (const recipientId of recipients) {
      emitToUser(recipientId, 'presence:update', payload);
      if (payload.isOnline) {
        emitToUser(recipientId, 'user:online', { userId, lastSeenAt: null });
      } else {
        emitToUser(recipientId, 'user:offline', { userId, lastSeenAt: payload.lastSeenAt });
      }
    }
  } catch (error) {
    logger.error('Presence broadcast failed', { userId, error: error.stack });
  }
}

// First device connected → online. Safe to call without awaiting from socket handlers.
export function handleUserCameOnline(userId) {
  return broadcastPresence(userId, { isOnline: true, lastSeenAt: null });
}

// Last device disconnected → offline + persist lastSeen.
export async function handleUserWentOffline(userId, lastSeenAt) {
  try {
    await persistLastSeen(userId, lastSeenAt);
  } catch (error) {
    logger.error('Failed to persist lastSeen', { userId, error: error.stack });
  }
  await broadcastPresence(userId, { isOnline: false, lastSeenAt });
}
