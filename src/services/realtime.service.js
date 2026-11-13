// Sends Socket.IO events to members. Every event goes to the private room "user:{userId}";
// clients can never join rooms themselves. When no socket server is running (tests, scripts)
// emits are silently skipped, because REST stays the source of truth.
//
// Presence: a member is online while at least one of their sockets is connected (multi-device).
// Transitions are reported so callers can broadcast user:online / user:offline / presence:update.

let realtimeNamespace = null;

/** @type {null | ((userId: string, change: { isOnline: boolean, lastSeenAt: Date | null }) => void)} */
let presenceTransitionHandler = null;

// userId -> number of connected sockets (multi-device).
const onlineCounts = new Map();

// userId -> Date of the most recent transition to offline (in-memory; also persisted on User.lastActiveAt).
const lastSeenByUser = new Map();

// Called once by socket/index.js with the /v1 namespace.
export function attachRealtimeNamespace(namespace) {
  realtimeNamespace = namespace;
}

// Optional hook for presence broadcasts (registered by socket/index to avoid circular imports).
export function setPresenceTransitionHandler(handler) {
  presenceTransitionHandler = handler;
}

function notifyPresenceTransition(userId, change) {
  if (!presenceTransitionHandler) return;
  try {
    presenceTransitionHandler(userId, change);
  } catch {
    // Presence fan-out must never break socket lifecycle.
  }
}

// Called when the socket server shuts down.
export function detachRealtimeNamespace() {
  realtimeNamespace = null;
  presenceTransitionHandler = null;
  onlineCounts.clear();
  lastSeenByUser.clear();
}

// Returns the private room name of a member.
export function userRoom(userId) {
  return `user:${userId}`;
}

// Marks a member online when one of their devices connects.
// becameOnline is true only for the first connected socket of that member.
export function trackUserOnline(userId) {
  const previous = onlineCounts.get(userId) ?? 0;
  onlineCounts.set(userId, previous + 1);
  const becameOnline = previous === 0;
  if (becameOnline) {
    notifyPresenceTransition(userId, { isOnline: true, lastSeenAt: null });
  }
  return { becameOnline };
}

// Marks a member offline when one of their devices disconnects.
// becameOffline is true only when the last connected socket closes.
export function trackUserOffline(userId) {
  if (!onlineCounts.has(userId)) {
    return { becameOffline: false, lastSeenAt: lastSeenByUser.get(userId) ?? null };
  }

  const next = (onlineCounts.get(userId) ?? 1) - 1;
  if (next > 0) {
    onlineCounts.set(userId, next);
    return { becameOffline: false, lastSeenAt: null };
  }

  onlineCounts.delete(userId);
  const lastSeenAt = new Date();
  lastSeenByUser.set(userId, lastSeenAt);
  notifyPresenceTransition(userId, { isOnline: false, lastSeenAt });
  return { becameOffline: true, lastSeenAt };
}

// Forces a member offline in the presence map (session revoke / ban).
export function clearUserOnline(userId) {
  const wasOnline = onlineCounts.has(userId);
  onlineCounts.delete(userId);
  if (!wasOnline) {
    return { becameOffline: false, lastSeenAt: lastSeenByUser.get(userId) ?? null };
  }
  const lastSeenAt = new Date();
  lastSeenByUser.set(userId, lastSeenAt);
  return { becameOffline: true, lastSeenAt };
}

// True when the member has at least one connected socket.
export function isUserOnline(userId) {
  return (onlineCounts.get(userId) ?? 0) > 0;
}

// In-memory lastSeen from the last offline transition, if any.
export function getCachedLastSeenAt(userId) {
  return lastSeenByUser.get(userId) ?? null;
}

// Snapshot of currently online member ids (for admin lists and stats).
export function getOnlineUserIds() {
  return new Set(onlineCounts.keys());
}

// How many distinct members are online right now.
export function getOnlineUserCount() {
  return onlineCounts.size;
}

// Emits one event to every connected device of a member.
export function emitToUser(userId, event, payload) {
  if (!realtimeNamespace) return;
  realtimeNamespace.to(userRoom(userId)).emit(event, payload);
}

// Tells every connected device of a member that the session ended, then disconnects them
// (used for bans, suspensions and account deletion).
export function endUserSockets(userId) {
  if (realtimeNamespace) {
    realtimeNamespace.to(userRoom(userId)).emit('session:expired', { code: 'UNAUTHENTICATED' });
    realtimeNamespace.in(userRoom(userId)).disconnectSockets(true);
  }
  // Sync disconnect handlers normally clear the count and emit offline once.
  // Force-clear only when sockets were not attached or disconnect is deferred.
  if (!onlineCounts.has(userId)) return;
  const transition = clearUserOnline(userId);
  if (transition.becameOffline) {
    notifyPresenceTransition(userId, { isOnline: false, lastSeenAt: transition.lastSeenAt });
  }
}

// Connected socket count for admin monitoring (null when realtime is not attached).
export function getConnectedSocketCount() {
  return realtimeNamespace?.sockets?.size ?? null;
}
