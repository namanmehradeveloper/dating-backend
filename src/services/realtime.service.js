// Sends Socket.IO events to members. Every event goes to the private room "user:{userId}";
// clients can never join rooms themselves. When no socket server is running (tests, scripts)
// emits are silently skipped, because REST stays the source of truth.

let realtimeNamespace = null;

// userId -> number of connected sockets (multi-device).
const onlineCounts = new Map();

// Called once by socket/index.js with the /v1 namespace.
export function attachRealtimeNamespace(namespace) {
  realtimeNamespace = namespace;
}

// Called when the socket server shuts down.
export function detachRealtimeNamespace() {
  realtimeNamespace = null;
  onlineCounts.clear();
}

// Returns the private room name of a member.
export function userRoom(userId) {
  return `user:${userId}`;
}

// Marks a member online when one of their devices connects.
export function trackUserOnline(userId) {
  onlineCounts.set(userId, (onlineCounts.get(userId) ?? 0) + 1);
}

// Marks a member offline when one of their devices disconnects.
export function trackUserOffline(userId) {
  const next = (onlineCounts.get(userId) ?? 1) - 1;
  if (next <= 0) onlineCounts.delete(userId);
  else onlineCounts.set(userId, next);
}

// True when the member has at least one connected socket.
export function isUserOnline(userId) {
  return (onlineCounts.get(userId) ?? 0) > 0;
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
  if (!realtimeNamespace) return;
  realtimeNamespace.to(userRoom(userId)).emit('session:expired', { code: 'UNAUTHENTICATED' });
  realtimeNamespace.in(userRoom(userId)).disconnectSockets(true);
  onlineCounts.delete(userId);
}

// Connected socket count for admin monitoring (null when realtime is not attached).
export function getConnectedSocketCount() {
  return realtimeNamespace?.sockets?.size ?? null;
}
