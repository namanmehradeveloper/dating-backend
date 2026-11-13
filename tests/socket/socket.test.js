// Tests the Socket.IO /v1 namespace against a real HTTP server: JWT handshake, private rooms,
// server events triggered through REST, client events with acks, blocks and session expiry.

import http from 'node:http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { io as connectClient } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { Block } from '../../src/models/Block.js';
import { User } from '../../src/models/User.js';
import { endUserSockets } from '../../src/services/realtime.service.js';
import { applyVerifiedEntitlement } from '../../src/services/subscription.service.js';
import { createSocketServer } from '../../src/socket/index.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';

const app = createApp();
let server;
let socketServer;
let socketUrl;
const openClients = [];

// Opens a client socket with the given token; resolves once connected or rejects with connect_error.
function connect(token) {
  return new Promise((resolve, reject) => {
    const client = connectClient(socketUrl, { transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    openClients.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

// Resolves with the next payload of an event, or rejects after a timeout.
function nextEvent(client, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event} event`)), timeoutMs);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// Resolves true when the event arrives within the window, false otherwise.
async function receivesEvent(client, event, windowMs = 300) {
  return nextEvent(client, event, windowMs).then(() => true, () => false);
}

// Emits a client event and resolves with its acknowledgement.
function emitWithAck(client, event, payload) {
  return client.timeout(3000).emitWithAck(event, payload);
}

// Sends a chat message over REST.
function sendMessage(member, conversationId, text = 'Hello') {
  const clientMessageId = uuidv4();
  return request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(bearer(member.token))
    .set('Idempotency-Key', clientMessageId)
    .send({ text, clientMessageId });
}

describe('Socket.IO /v1', () => {
  useTestDatabase();

  beforeAll(async () => {
    server = http.createServer(app);
    socketServer = createSocketServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    socketUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  afterEach(() => {
    while (openClients.length) openClients.pop().disconnect();
  });

  afterAll(async () => {
    await new Promise((resolve) => socketServer.close(resolve));
  });

  it('rejects a missing or invalid token with UNAUTHENTICATED', async () => {
    await expect(connect(undefined)).rejects.toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
    await expect(connect('not-a-jwt')).rejects.toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects banned members', async () => {
    const member = await createMember();
    await User.updateOne({ _id: member.id }, { status: 'BANNED' });
    await expect(connect(member.token)).rejects.toMatchObject({ data: { code: 'ACCOUNT_INELIGIBLE' } });
  });

  it('delivers message:new to both participants but nobody else', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, alex, avery);
    const [alexSocket, averySocket, outsiderSocket] = await Promise.all([connect(alex.token), connect(avery.token), connect(outsider.token)]);

    const received = Promise.all([nextEvent(alexSocket, 'message:new'), nextEvent(averySocket, 'message:new')]);
    const outsiderHears = receivesEvent(outsiderSocket, 'message:new');
    const sent = (await sendMessage(alex, match.conversationId, 'Hi there')).body.data;

    const [toAlex, toAvery] = await received;
    expect(toAlex).toEqual({ message: sent });
    expect(toAvery).toEqual({ message: sent });
    expect(await outsiderHears).toBe(false);
  });

  it('sends match:new to the other member when a like becomes a match', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const averySocket = await connect(avery.token);

    await swipe(app, avery, alex.id, 'LIKE');
    const matchNew = nextEvent(averySocket, 'match:new');
    const res = await swipe(app, alex, avery.id, 'LIKE');

    const payload = await matchNew;
    expect(payload.match).toMatchObject({ id: res.body.data.match.id, otherUser: { id: alex.id }, conversationId: res.body.data.match.conversationId });
  });

  it('sends match:removed to both members on unmatch, without a reason', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const [alexSocket, averySocket] = await Promise.all([connect(alex.token), connect(avery.token)]);

    const removed = Promise.all([nextEvent(alexSocket, 'match:removed'), nextEvent(averySocket, 'match:removed')]);
    await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(alex.token));
    const expected = { matchId: match.id, conversationId: match.conversationId };
    expect(await removed).toEqual([expected, expected]);
  });

  it('relays typing to the other participant and rate-limits it to one event per 3 s', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const [alexSocket, averySocket] = await Promise.all([connect(alex.token), connect(avery.token)]);

    const typing = nextEvent(averySocket, 'typing');
    const ack = await emitWithAck(alexSocket, 'typing', { conversationId: match.conversationId, isTyping: true, userId: avery.id });
    expect(ack).toEqual({ ok: true });
    expect(await typing).toEqual({ conversationId: match.conversationId, userId: alex.id, isTyping: true });

    const second = await emitWithAck(alexSocket, 'typing', { conversationId: match.conversationId, isTyping: false });
    expect(second).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('rejects typing in a conversation the member is not part of', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, alex, avery);
    const outsiderSocket = await connect(outsider.token);

    const ack = await emitWithAck(outsiderSocket, 'typing', { conversationId: match.conversationId, isTyping: true });
    expect(ack).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('stops chat events between members once one blocks the other', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const [alexSocket, averySocket] = await Promise.all([connect(alex.token), connect(avery.token)]);

    await Block.create({ blockerId: avery.id, blockedId: alex.id });
    const averyHears = receivesEvent(averySocket, 'typing');
    const ack = await emitWithAck(alexSocket, 'typing', { conversationId: match.conversationId, isTyping: true });
    expect(ack).toMatchObject({ ok: false, error: { code: 'MATCH_REQUIRED' } });
    expect(await averyHears).toBe(false);
  });

  it('marks messages read via message:read and emits message:read to both members', async () => {
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const sent = (await sendMessage(alex, match.conversationId)).body.data;
    const [alexSocket, averySocket] = await Promise.all([connect(alex.token), connect(avery.token)]);

    const readEvent = nextEvent(alexSocket, 'message:read');
    const ack = await emitWithAck(averySocket, 'message:read', { conversationId: match.conversationId, upToMessageId: sent.id });
    expect(ack).toEqual({ ok: true });
    expect(await readEvent).toMatchObject({ conversationId: match.conversationId, readerId: avery.id, upToMessageId: sent.id });

    const ownMessage = await emitWithAck(alexSocket, 'message:read', { conversationId: match.conversationId, upToMessageId: sent.id });
    expect(ownMessage).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const unknown = await emitWithAck(averySocket, 'message:read', { conversationId: match.conversationId, upToMessageId: 'msg_unknown' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('sends entitlement:updated when the entitlement changes', async () => {
    const member = await createMember();
    const client = await connect(member.token);
    const updated = nextEvent(client, 'entitlement:updated');
    await applyVerifiedEntitlement(member.id, { tier: 'PLUS', isActive: true, expiresAt: new Date(Date.now() + 86400000) });
    expect(await updated).toEqual({ tier: 'PLUS', isActive: true });
  });

  it('emits session:expired and disconnects when the access token expires', async () => {
    const member = await createMember();
    const shortToken = jwt.sign({ role: 'USER', typ: 'access' }, env.jwtAccessSecret, { algorithm: 'HS256', subject: member.id, expiresIn: 1 });
    const client = await connect(shortToken);
    const expired = nextEvent(client, 'session:expired', 3000);
    const disconnected = nextEvent(client, 'disconnect', 3000);

    expect(await expired).toEqual({ code: 'UNAUTHENTICATED' });
    await disconnected;
  });

  it('ends every socket of a member when the session is revoked', async () => {
    const member = await createMember();
    const client = await connect(member.token);
    const expired = nextEvent(client, 'session:expired');
    const disconnected = nextEvent(client, 'disconnect');
    endUserSockets(member.id);
    expect(await expired).toEqual({ code: 'UNAUTHENTICATED' });
    await disconnected;
  });

  it('ends every socket and refuses the old token after sign out of all devices', async () => {
    const member = await createMember();
    const phone = await connect(member.token);
    const laptop = await connect(member.token);
    const phoneExpired = nextEvent(phone, 'session:expired');
    const laptopExpired = nextEvent(laptop, 'session:expired');

    expect((await request(app).post('/api/v1/auth/logout-all').set(bearer(member.token))).status).toBe(200);
    expect(await phoneExpired).toEqual({ code: 'UNAUTHENTICATED' });
    expect(await laptopExpired).toEqual({ code: 'UNAUTHENTICATED' });
    await expect(connect(member.token)).rejects.toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
  });

  it('broadcasts presence to conversation partners across connect, multi-device and disconnect', async () => {
    const alex = await createMember();
    const avery = await createMember();
    await matchMembers(app, alex, avery);
    const averySocket = await connect(avery.token);

    const onlineUpdate = nextEvent(averySocket, 'presence:update');
    const userOnline = nextEvent(averySocket, 'user:online');
    const alexPhone = await connect(alex.token);
    expect(await onlineUpdate).toEqual({ userId: alex.id, isOnline: true, lastSeenAt: null });
    expect(await userOnline).toEqual({ userId: alex.id, lastSeenAt: null });

    const listWhileOnline = await request(app).get('/api/v1/conversations').set(bearer(avery.token));
    expect(listWhileOnline.body.data.items[0].otherUser).toMatchObject({ id: alex.id, isOnline: true, lastSeenAt: null });

    // Second device must not emit another online transition.
    const noSecondOnline = receivesEvent(averySocket, 'user:online', 250);
    const alexLaptop = await connect(alex.token);
    expect(await noSecondOnline).toBe(false);

    // Closing one device keeps the member online.
    const stillOnline = receivesEvent(averySocket, 'user:offline', 250);
    alexPhone.disconnect();
    expect(await stillOnline).toBe(false);
    expect((await request(app).get('/api/v1/conversations').set(bearer(avery.token))).body.data.items[0].otherUser.isOnline).toBe(true);

    const offlineUpdate = nextEvent(averySocket, 'presence:update');
    const userOffline = nextEvent(averySocket, 'user:offline');
    alexLaptop.disconnect();
    const offlinePayload = await offlineUpdate;
    expect(offlinePayload).toMatchObject({ userId: alex.id, isOnline: false });
    expect(offlinePayload.lastSeenAt).toEqual(expect.any(String));
    expect(await userOffline).toEqual({ userId: alex.id, lastSeenAt: offlinePayload.lastSeenAt });

    const listWhileOffline = await request(app).get('/api/v1/conversations').set(bearer(avery.token));
    expect(listWhileOffline.body.data.items[0].otherUser).toMatchObject({
      id: alex.id,
      isOnline: false,
      lastSeenAt: offlinePayload.lastSeenAt,
    });
  });

  it('hides online status when the member disables showOnlineStatus', async () => {
    const alex = await createMember();
    const avery = await createMember();
    await matchMembers(app, alex, avery);
    const { Profile } = await import('../../src/models/Profile.js');
    await Profile.updateOne({ userId: alex.id }, { $set: { 'privacy.showOnlineStatus': false } });

    const averySocket = await connect(avery.token);
    const hiddenOnline = nextEvent(averySocket, 'presence:update');
    await connect(alex.token);
    expect(await hiddenOnline).toEqual({ userId: alex.id, isOnline: false, lastSeenAt: null });

    const list = await request(app).get('/api/v1/conversations').set(bearer(avery.token));
    expect(list.body.data.items[0].otherUser).toMatchObject({ id: alex.id, isOnline: false, lastSeenAt: null });
  });
});
