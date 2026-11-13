import http from 'node:http';
import request from 'supertest';
import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Call } from '../../src/models/Call.js';
import { createSocketServer } from '../../src/socket/index.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();
let server;
let socketServer;
let socketUrl;
const openClients = [];

function connect(token) {
  return new Promise((resolve, reject) => {
    const client = connectClient(socketUrl, { transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    openClients.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

function nextEvent(client, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event} event`)), 3000);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function start(member, conversationId, type = 'AUDIO') {
  return request(app)
    .post('/api/v1/calls')
    .set(bearer(member.token))
    .send({ conversationId, type });
}

describe('call signalling API', () => {
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

  it('requires the existing JWT authentication and validates call type', async () => {
    const unauthenticated = await request(app).post('/api/v1/calls').send({ conversationId: 'conversation', type: 'AUDIO' });
    expect(unauthenticated.status).toBe(401);

    const member = await createMember();
    const invalid = await request(app)
      .post('/api/v1/calls')
      .set(bearer(member.token))
      .send({ conversationId: 'conversation', type: 'TEXT' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toContainEqual({ field: 'type', reason: 'INVALID' });
  });

  it('generates participant-specific Agora tokens and completes an audio or video call', async () => {
    const caller = await createMember();
    const callee = await createMember();
    const match = await matchMembers(app, caller, callee);
    const incoming = await connect(callee.token);

    const incomingEvent = nextEvent(incoming, 'call:incoming');
    const started = await start(caller, match.conversationId, 'VIDEO');
    expect(started.status).toBe(201);
    expect(started.body.data.call).toMatchObject({
      conversationId: match.conversationId,
      callerId: caller.id,
      calleeId: callee.id,
      type: 'VIDEO',
      status: 'RINGING',
    });
    expect(started.body.data.credentials).toMatchObject({
      appId: '0123456789abcdef0123456789abcdef',
      channelName: expect.any(String),
      token: expect.any(String),
      uid: expect.any(Number),
    });
    expect(JSON.stringify(started.body.data)).not.toContain('appCertificate');
    expect(await incomingEvent).toEqual({ call: started.body.data.call });

    const callerSocket = await connect(caller.token);
    const acceptedEvent = nextEvent(callerSocket, 'call:accepted');
    const accepted = await request(app)
      .post(`/api/v1/calls/${started.body.data.call.id}/accept`)
      .set(bearer(callee.token));
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.call.status).toBe('ACCEPTED');
    expect(accepted.body.data.credentials.channelName).toBe(started.body.data.credentials.channelName);
    expect(accepted.body.data.credentials.uid).not.toBe(started.body.data.credentials.uid);
    expect(accepted.body.data.credentials.token).not.toBe(started.body.data.credentials.token);
    expect(await acceptedEvent).toEqual({ call: accepted.body.data.call });

    const callerMessages = await connect(caller.token);
    const callMessageEvent = nextEvent(callerMessages, 'message:new');
    const ended = await request(app)
      .post(`/api/v1/calls/${started.body.data.call.id}/end`)
      .set(bearer(caller.token));
    expect(ended.body.data.status).toBe('ENDED');
    expect(await Call.countDocuments({ activeParticipants: { $exists: true } })).toBe(0);

    const history = await request(app).get('/api/v1/calls').set(bearer(caller.token));
    expect(history.body.data.items).toHaveLength(1);
    expect(history.body.data.items[0].status).toBe('ENDED');

    const callMessage = await callMessageEvent;
    expect(callMessage.message).toMatchObject({
      conversationId: match.conversationId,
      senderId: caller.id,
      text: '',
      attachment: null,
      call: {
        callId: started.body.data.call.id,
        type: 'VIDEO',
        status: 'ENDED',
        durationSeconds: expect.any(Number),
      },
    });

    const thread = await request(app)
      .get(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(callee.token));
    expect(thread.status).toBe(200);
    expect(thread.body.data.items.some((item) => item.call?.callId === started.body.data.call.id)).toBe(true);
  });

  it('handles rejection, cancellation, busy participants and missed calls', async () => {
    const caller = await createMember();
    const callee = await createMember();
    const third = await createMember();
    const firstMatch = await matchMembers(app, caller, callee);
    const secondMatch = await matchMembers(app, callee, third);

    const rejected = await start(caller, firstMatch.conversationId);
    const rejectResult = await request(app)
      .post(`/api/v1/calls/${rejected.body.data.call.id}/reject`)
      .set(bearer(callee.token));
    expect(rejectResult.body.data.status).toBe('REJECTED');

    const cancelled = await start(caller, firstMatch.conversationId);
    const cancelResult = await request(app)
      .post(`/api/v1/calls/${cancelled.body.data.call.id}/cancel`)
      .set(bearer(caller.token));
    expect(cancelResult.body.data.status).toBe('CANCELLED');

    const active = await start(caller, firstMatch.conversationId);
    const busy = await start(third, secondMatch.conversationId);
    expect(busy.body.data.call.status).toBe('BUSY');
    expect(busy.body.data.credentials).toBeNull();
    const anotherBusy = await start(third, secondMatch.conversationId);
    expect(anotherBusy.body.data.call.status).toBe('BUSY');

    await Call.updateOne({ _id: active.body.data.call.id }, { $set: { ringExpiresAt: new Date(Date.now() - 1000) } });
    const missed = await request(app).get('/api/v1/calls/active').set(bearer(caller.token));
    expect(missed.body.data.call).toBeNull();
    expect((await Call.findById(active.body.data.call.id)).status).toBe('MISSED');

    const firstThread = await request(app)
      .get(`/api/v1/conversations/${firstMatch.conversationId}/messages`)
      .set(bearer(caller.token));
    const callStatuses = firstThread.body.data.items.map((item) => item.call?.status).filter(Boolean);
    expect(callStatuses).toEqual(expect.arrayContaining(['REJECTED', 'CANCELLED', 'MISSED']));

    const secondThread = await request(app)
      .get(`/api/v1/conversations/${secondMatch.conversationId}/messages`)
      .set(bearer(third.token));
    const busyLogs = secondThread.body.data.items.filter((item) => item.call?.status === 'BUSY');
    expect(busyLogs).toHaveLength(2);
    expect(busyLogs[0].call.callId).not.toBe(busyLogs[1].call.callId);
  });

  it('does not disclose calls to non-participants or allow outsiders to place calls', async () => {
    const caller = await createMember();
    const callee = await createMember();
    const outsider = await createMember();
    const match = await matchMembers(app, caller, callee);

    const started = await start(caller, match.conversationId);
    const hidden = await request(app)
      .post(`/api/v1/calls/${started.body.data.call.id}/accept`)
      .set(bearer(outsider.token));
    expect(hidden.status).toBe(404);

    const noMatch = await start(caller, 'not-a-conversation');
    expect(noMatch.status).toBe(404);
  });
});
