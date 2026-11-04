// Tests push device registration, the notification inbox (fed by real match/like events)
// and notification preferences.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Device } from '../../src/models/Device.js';
import { Notification } from '../../src/models/Notification.js';
import { notifyUser } from '../../src/services/notification.service.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';

const app = createApp();

describe('devices', () => {
  useTestDatabase();

  it('registers a device and moves a reused push token to the new member', async () => {
    const first = await createMember();
    const second = await createMember();
    const body = { platform: 'ANDROID', pushToken: 'fcm-token-1', appVersion: '1.0.0', locale: 'en-IN' };

    const res = await request(app).post('/api/v1/devices').set(bearer(first.token)).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: expect.stringMatching(/^dev_/), platform: 'ANDROID', lastSeenAt: expect.any(String) });

    await request(app).post('/api/v1/devices').set(bearer(second.token)).send(body);
    expect(await Device.countDocuments()).toBe(1);
    expect((await Device.findOne()).userId).toBe(second.id);
  });

  it('validates the device', async () => {
    const member = await createMember();
    const res = await request(app).post('/api/v1/devices').set(bearer(member.token)).send({ platform: 'WINDOWS' });
    expect(res.body.error.details).toEqual([
      { field: 'platform', reason: 'UNKNOWN_OPTION' },
      { field: 'pushToken', reason: 'REQUIRED' },
    ]);
  });

  it('removes only your own devices', async () => {
    const owner = await createMember();
    const other = await createMember();
    const device = (await request(app).post('/api/v1/devices').set(bearer(owner.token)).send({ platform: 'IOS', pushToken: 'apns' })).body.data;

    expect((await request(app).delete(`/api/v1/devices/${device.id}`).set(bearer(other.token))).status).toBe(404);
    const res = await request(app).delete(`/api/v1/devices/${device.id}`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(await Device.countDocuments()).toBe(0);
  });
});

describe('notification inbox', () => {
  useTestDatabase();

  it('stores NEW_LIKE and NEW_MATCH notifications with generic text', async () => {
    const alex = await createMember();
    const avery = await createMember();
    await swipe(app, alex, avery.id, 'LIKE');
    const match = await matchMembers(app, alex, avery);

    const res = await request(app).get('/api/v1/notifications').set(bearer(avery.token));
    const types = res.body.data.items.map((item) => item.type);
    expect(types).toContain('NEW_LIKE');
    expect(types).toContain('NEW_MATCH');
    const matchNotification = res.body.data.items.find((item) => item.type === 'NEW_MATCH');
    expect(matchNotification).toEqual({
      id: expect.stringMatching(/^ntf_/),
      type: 'NEW_MATCH',
      title: expect.any(String),
      body: expect.any(String),
      data: { matchId: match.id },
      createdAt: expect.any(String),
      readAt: null,
    });
  });

  it('paginates and marks notifications read', async () => {
    const member = await createMember();
    for (let index = 0; index < 3; index += 1) {
      await notifyUser(member.id, { type: 'SYSTEM', title: `Notice ${index}`, body: 'Body' });
    }

    const first = await request(app).get('/api/v1/notifications?limit=2').set(bearer(member.token));
    expect(first.body.data.items.map((item) => item.title)).toEqual(['Notice 2', 'Notice 1']);
    const second = await request(app).get(`/api/v1/notifications?limit=2&cursor=${first.body.data.nextCursor}`).set(bearer(member.token));
    expect(second.body.data.items.map((item) => item.title)).toEqual(['Notice 0']);

    const id = first.body.data.items[0].id;
    expect((await request(app).post(`/api/v1/notifications/${id}/read`).set(bearer(member.token))).status).toBe(200);
    expect((await Notification.findById(id)).readAt).toBeInstanceOf(Date);

    const other = await createMember();
    expect((await request(app).post(`/api/v1/notifications/${id}/read`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('notification preferences', () => {
  useTestDatabase();

  it('returns defaults and applies partial updates', async () => {
    const member = await createMember();
    const defaults = await request(app).get('/api/v1/notification-preferences').set(bearer(member.token));
    expect(defaults.body.data).toEqual({ newMatches: true, messages: true, likes: true, promotions: false });

    const res = await request(app).patch('/api/v1/notification-preferences').set(bearer(member.token)).send({ likes: false });
    expect(res.body.data).toEqual({ newMatches: true, messages: true, likes: false, promotions: false });
  });

  it('skips notifications the member switched off', async () => {
    const alex = await createMember();
    const avery = await createMember();
    await request(app).patch('/api/v1/notification-preferences').set(bearer(avery.token)).send({ likes: false });
    await swipe(app, alex, avery.id, 'LIKE');
    expect(await Notification.countDocuments({ userId: avery.id, type: 'NEW_LIKE' })).toBe(0);
  });

  it('rejects unknown fields, non-booleans and empty updates', async () => {
    const member = await createMember();
    const patch = (body) => request(app).patch('/api/v1/notification-preferences').set(bearer(member.token)).send(body);
    expect((await patch({ sms: true })).body.error.details).toEqual([{ field: 'sms', reason: 'UNKNOWN_FIELD' }]);
    expect((await patch({ likes: 'yes' })).body.error.details).toEqual([{ field: 'likes', reason: 'INVALID' }]);
    expect((await patch({})).body.error.details).toEqual([{ field: 'body', reason: 'NO_FIELDS' }]);
  });
});
