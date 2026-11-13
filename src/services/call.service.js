import { randomInt, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import agoraToken from 'agora-token';
import { env } from '../config/env.js';
import { Call, ACTIVE_CALL_STATUSES } from '../models/Call.js';
import { getConversation, recordCallMessage } from './chat.service.js';
import { emitToUser } from './realtime.service.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

async function appendCallToChat(call) {
  if (!call) return;
  try {
    await recordCallMessage(call);
  } catch (error) {
    logger.error('Failed to record call chat message', { callId: String(call._id), error: error.stack });
  }
}

const TOKEN_TTL_SECONDS = 60 * 60;
const { RtcRole, RtcTokenBuilder } = agoraToken;

function assertAgoraConfigured() {
  if (!env.agora.enabled) throw new ApiError('FEATURE_NOT_CONFIGURED', { message: 'Voice and video calling are not configured.' });
}

function callDto(call) {
  return {
    id: String(call._id),
    conversationId: call.conversationId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    type: call.type,
    status: call.status,
    createdAt: call.createdAt,
    ringExpiresAt: call.ringExpiresAt,
    acceptedAt: call.acceptedAt ?? null,
    endedAt: call.endedAt ?? null,
  };
}

function credentialsFor(call, userId) {
  assertAgoraConfigured();
  const uid = userId === call.callerId ? call.callerAgoraUid : call.calleeAgoraUid;
  const token = RtcTokenBuilder.buildTokenWithUid(
    env.agora.appId,
    env.agora.appCertificate,
    call.channelName,
    uid,
    RtcRole.PUBLISHER,
    TOKEN_TTL_SECONDS,
    TOKEN_TTL_SECONDS,
  );
  return {
    appId: env.agora.appId,
    channelName: call.channelName,
    token,
    uid,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
  };
}

function createCallRecord({ conversationId, callerId, calleeId, type, status = 'RINGING', activeParticipants }) {
  const callerAgoraUid = randomInt(1, 0x7fffffff);
  let calleeAgoraUid = randomInt(1, 0x7fffffff);
  while (calleeAgoraUid === callerAgoraUid) calleeAgoraUid = randomInt(1, 0x7fffffff);
  const now = new Date();
  const call = new Call({
    conversationId,
    callerId,
    calleeId,
    type,
    status,
    channelName: `call_${randomUUID().replaceAll('-', '')}`,
    callerAgoraUid,
    calleeAgoraUid,
    ...(activeParticipants?.length ? { activeParticipants } : {}),
    ringExpiresAt: new Date(now.getTime() + env.callRingTimeoutSeconds * 1000),
    ...(status === 'BUSY' ? { endedAt: now } : {}),
  });
  return call.save();
}

async function findCallForParticipant(callId, userId) {
  if (!mongoose.isValidObjectId(callId)) throw ApiError.notFound();
  const call = await Call.findById(callId);
  if (!call || (call.callerId !== userId && call.calleeId !== userId)) throw ApiError.notFound();
  return call;
}

async function expireCall(call) {
  const expired = await Call.findOneAndUpdate(
    { _id: call._id, status: 'RINGING', ringExpiresAt: { $lte: new Date() } },
    { $set: { status: 'MISSED', endedAt: new Date() }, $unset: { activeParticipants: 1 } },
    { returnDocument: 'after' },
  );
  if (expired) {
    const event = { call: callDto(expired) };
    emitToUser(expired.callerId, 'call:missed', event);
    emitToUser(expired.calleeId, 'call:missed', event);
    await appendCallToChat(expired);
  }
  return expired;
}

async function expireCallsForUser(userId) {
  const overdue = await Call.find({
    activeParticipants: userId,
    status: 'RINGING',
    ringExpiresAt: { $lte: new Date() },
  });
  for (const call of overdue) await expireCall(call);
}

async function rejectExpiredRingingCall(call) {
  if (call.status !== 'RINGING' || call.ringExpiresAt > new Date()) return;
  await expireCall(call);
  throw ApiError.conflict('This call has expired.');
}

async function createBusyCall({ conversationId, callerId, calleeId, type }) {
  const call = await createCallRecord({ conversationId, callerId, calleeId, type, status: 'BUSY' });
  emitToUser(callerId, 'call:busy', { call: callDto(call) });
  await appendCallToChat(call);
  return { call: callDto(call), credentials: null };
}

// Starts a call only between the participants of an active, visible match conversation.
export async function startCall(userId, { conversationId, type }) {
  assertAgoraConfigured();
  userId = String(userId);
  const conversation = await getConversation(userId, conversationId);
  const callerId = userId;
  const calleeId = conversation.otherUser.id;
  const input = { conversationId, callerId, calleeId, type };

  await Promise.all([expireCallsForUser(callerId), expireCallsForUser(calleeId)]);
  if (await Call.exists({ activeParticipants: callerId, status: { $in: ACTIVE_CALL_STATUSES } })) {
    throw ApiError.conflict('You are already in a call.');
  }
  if (await Call.exists({ activeParticipants: calleeId, status: { $in: ACTIVE_CALL_STATUSES } })) {
    return createBusyCall(input);
  }

  let call;
  try {
    call = await createCallRecord({ ...input, activeParticipants: [callerId, calleeId] });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    if (await Call.exists({ activeParticipants: callerId, status: { $in: ACTIVE_CALL_STATUSES } })) {
      throw ApiError.conflict('You are already in a call.');
    }
    if (await Call.exists({ activeParticipants: calleeId, status: { $in: ACTIVE_CALL_STATUSES } })) {
      return createBusyCall(input);
    }
    throw error;
  }

  const safeCall = callDto(call);
  emitToUser(calleeId, 'call:incoming', { call: safeCall });
  return { call: safeCall, credentials: credentialsFor(call, callerId) };
}

// Accepts the ringing call and gives only the authenticated callee their own Agora token.
export async function acceptCall(userId, callId) {
  assertAgoraConfigured();
  userId = String(userId);
  const current = await findCallForParticipant(callId, userId);
  if (current.calleeId !== userId) throw ApiError.notFound();
  await getConversation(userId, current.conversationId);

  await rejectExpiredRingingCall(current);
  let call = current;
  if (current.status === 'RINGING') {
    call = await Call.findOneAndUpdate(
      { _id: callId, calleeId: userId, status: 'RINGING', ringExpiresAt: { $gt: new Date() } },
      { $set: { status: 'ACCEPTED', acceptedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!call) throw ApiError.conflict('This call is no longer available.');
  } else if (current.status !== 'ACCEPTED') {
    throw ApiError.conflict('This call is no longer available.');
  }

  emitToUser(call.callerId, 'call:accepted', { call: callDto(call) });
  return { call: callDto(call), credentials: credentialsFor(call, userId) };
}

// Rejects only the incoming participant's ringing call.
export async function rejectCall(userId, callId) {
  userId = String(userId);
  const current = await findCallForParticipant(callId, userId);
  if (current.calleeId !== userId) throw ApiError.notFound();
  await rejectExpiredRingingCall(current);
  if (current.status !== 'RINGING') throw ApiError.conflict('This call is no longer ringing.');
  const call = await Call.findOneAndUpdate(
    { _id: callId, calleeId: userId, status: 'RINGING' },
    { $set: { status: 'REJECTED', endedAt: new Date() }, $unset: { activeParticipants: 1 } },
    { returnDocument: 'after' },
  );
  if (!call) throw ApiError.conflict('This call is no longer ringing.');
  emitToUser(call.callerId, 'call:rejected', { call: callDto(call) });
  await appendCallToChat(call);
  return callDto(call);
}

// Cancels only the caller's ringing call.
export async function cancelCall(userId, callId) {
  userId = String(userId);
  const current = await findCallForParticipant(callId, userId);
  if (current.callerId !== userId) throw ApiError.notFound();
  await rejectExpiredRingingCall(current);
  if (current.status !== 'RINGING') throw ApiError.conflict('This call can no longer be cancelled.');
  const call = await Call.findOneAndUpdate(
    { _id: callId, callerId: userId, status: 'RINGING' },
    { $set: { status: 'CANCELLED', endedAt: new Date() }, $unset: { activeParticipants: 1 } },
    { returnDocument: 'after' },
  );
  if (!call) throw ApiError.conflict('This call can no longer be cancelled.');
  emitToUser(call.calleeId, 'call:cancelled', { call: callDto(call) });
  await appendCallToChat(call);
  return callDto(call);
}

// Ends an accepted call for either participant and releases both participants for new calls.
export async function endCall(userId, callId) {
  userId = String(userId);
  const current = await findCallForParticipant(callId, userId);
  if (current.status !== 'ACCEPTED') throw ApiError.conflict('Only an accepted call can be ended.');
  const call = await Call.findOneAndUpdate(
    { _id: callId, status: 'ACCEPTED', activeParticipants: userId },
    { $set: { status: 'ENDED', endedAt: new Date() }, $unset: { activeParticipants: 1 } },
    { returnDocument: 'after' },
  );
  if (!call) throw ApiError.conflict('This call has already ended.');
  const event = { call: callDto(call) };
  emitToUser(call.callerId, 'call:ended', event);
  emitToUser(call.calleeId, 'call:ended', event);
  await appendCallToChat(call);
  return callDto(call);
}

// Recovers a live call after a socket reconnect or browser refresh.
export async function getActiveCall(userId) {
  userId = String(userId);
  let call = await Call.findOne({ activeParticipants: userId, status: { $in: ACTIVE_CALL_STATUSES } });
  if (call?.status === 'RINGING' && call.ringExpiresAt <= new Date()) {
    await expireCall(call);
    call = null;
  }
  if (!call) return { call: null, direction: null, credentials: null };
  const direction = call.callerId === userId ? 'OUTGOING' : 'INCOMING';
  const credentials = direction === 'INCOMING' && call.status === 'RINGING' ? null : credentialsFor(call, userId);
  return { call: callDto(call), direction, credentials };
}

// Returns recent calls involving the authenticated member.
export async function listCallHistory(userId, limit) {
  userId = String(userId);
  const calls = await Call.find({ $or: [{ callerId: userId }, { calleeId: userId }] })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return { items: calls.map(callDto) };
}

// Marks timed-out ringing calls as missed and notifies both participants.
export async function expireMissedCalls() {
  const overdue = await Call.find({ status: 'RINGING', ringExpiresAt: { $lte: new Date() } }).limit(100);
  for (const call of overdue) await expireCall(call);
  return overdue.length;
}

// Starts the process-local sweep; call records remain authoritative across server restarts.
export function startCallExpiryJob() {
  const timer = setInterval(() => {
    void expireMissedCalls().catch((error) => logger.error('Call expiry job failed', { error: error.stack }));
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
