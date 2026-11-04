// Socket.IO server on namespace /v1 (WebSocket only), attached to the same HTTP server as the API.
// The handshake JWT decides who the socket belongs to; payload user ids are never trusted.
// Each socket joins only its own room "user:{id}", and the session ends when the token expires.

import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { authenticateAccessToken } from '../middlewares/auth.middleware.js';
import { assertCanSendTyping, markConversationRead, otherParticipant } from '../services/chat.service.js';
import {
  attachRealtimeNamespace,
  detachRealtimeNamespace,
  emitToUser,
  trackUserOffline,
  trackUserOnline,
  userRoom,
} from '../services/realtime.service.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

const TYPING_INTERVAL_MS = 3000;
const MAX_TIMER_MS = 2 ** 31 - 1;

// Last accepted typing event per "userId:conversationId", shared by all devices of a member.
const lastTypingAt = new Map();

// Creates the Socket.IO server for an HTTP server and registers the /v1 namespace.
export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    transports: ['websocket'],
    cors: { origin: env.corsOrigins, credentials: false },
  });

  const namespace = io.of('/v1');
  namespace.use(authenticateSocket);
  namespace.on('connection', handleConnection);
  attachRealtimeNamespace(namespace);

  io.on('close', detachRealtimeNamespace);
  return io;
}

// Handshake middleware: verifies auth.token and stores the member id on the socket.
async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) throw ApiError.unauthenticated();
    const { user, tokenExpiresAt } = await authenticateAccessToken(token);
    socket.data.userId = user._id;
    socket.data.tokenExpiresAt = tokenExpiresAt;
    next();
  } catch (error) {
    const code = error instanceof ApiError && error.code === 'ACCOUNT_INELIGIBLE' ? 'ACCOUNT_INELIGIBLE' : 'UNAUTHENTICATED';
    const rejection = new Error(code);
    rejection.data = { code };
    next(rejection);
  }
}

// Sets up one authenticated socket: private room, expiry timer and client event handlers.
function handleConnection(socket) {
  const { userId } = socket.data;
  socket.join(userRoom(userId));
  trackUserOnline(userId);
  scheduleSessionExpiry(socket);

  socket.on('typing', (payload, ack) => runWithAck(ack, () => handleTyping(userId, payload)));
  socket.on('message:read', (payload, ack) => runWithAck(ack, () => handleMessageRead(userId, payload)));
  socket.on('disconnect', () => trackUserOffline(userId));
}

// Emits session:expired and disconnects the socket when its access token expires.
function scheduleSessionExpiry(socket) {
  const delay = Math.min(Math.max(socket.data.tokenExpiresAt.getTime() - Date.now(), 0), MAX_TIMER_MS);
  const timer = setTimeout(() => {
    socket.emit('session:expired', { code: 'UNAUTHENTICATED' });
    socket.disconnect(true);
  }, delay);
  socket.on('disconnect', () => clearTimeout(timer));
}

// Runs a client event handler and answers its ack with { ok: true } or { ok: false, error }.
async function runWithAck(ack, handler) {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    await handler();
    reply({ ok: true });
  } catch (error) {
    if (!(error instanceof ApiError)) logger.error('Socket event failed', { error: error.stack });
    const known = error instanceof ApiError ? error : ApiError.server();
    reply({ ok: false, error: { code: known.code, message: known.message } });
  }
}

// Reads a non-empty string field from a client payload or throws VALIDATION_ERROR.
function readPayloadId(payload, field) {
  const value = payload?.[field];
  if (typeof value !== 'string' || !value) throw ApiError.validation([{ field, reason: 'REQUIRED' }]);
  return value;
}

// "typing": relays { conversationId, userId, isTyping } to the other participant, at most every 3 s.
async function handleTyping(userId, payload) {
  const conversationId = readPayloadId(payload, 'conversationId');
  if (typeof payload.isTyping !== 'boolean') throw ApiError.validation([{ field: 'isTyping', reason: 'INVALID' }]);

  const conversation = await assertCanSendTyping(userId, conversationId);
  claimTypingSlot(`${userId}:${conversationId}`);

  emitToUser(otherParticipant(conversation, userId), 'typing', { conversationId, userId, isTyping: payload.isTyping });
}

// Allows one typing event per key every 3 s; the entry is dropped once the window has passed.
function claimTypingSlot(key) {
  const previous = lastTypingAt.get(key);
  const elapsed = Date.now() - (previous ?? 0);
  if (previous && elapsed < TYPING_INTERVAL_MS) {
    throw ApiError.rateLimited(Math.ceil((TYPING_INTERVAL_MS - elapsed) / 1000));
  }
  const now = Date.now();
  lastTypingAt.set(key, now);
  setTimeout(() => {
    if (lastTypingAt.get(key) === now) lastTypingAt.delete(key);
  }, TYPING_INTERVAL_MS).unref();
}

// "message:read": marks messages read up to upToMessageId (emits message:read to both members).
async function handleMessageRead(userId, payload) {
  const conversationId = readPayloadId(payload, 'conversationId');
  const upToMessageId = readPayloadId(payload, 'upToMessageId');
  await markConversationRead(userId, conversationId, upToMessageId);
}
