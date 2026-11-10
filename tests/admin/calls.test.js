// Admin call list / stats / detail (metadata only — no Agora tokens).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Call } from '../../src/models/Call.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

async function seedEndedCall({ type = 'AUDIO', status = 'ENDED' } = {}) {
  const caller = await createMember();
  const callee = await createMember();
  const match = await matchMembers(app, caller, callee);
  const acceptedAt = new Date(Date.now() - 90_000);
  const endedAt = new Date(Date.now() - 30_000);
  const call = await Call.create({
    conversationId: match.conversationId,
    callerId: caller.id,
    calleeId: callee.id,
    type,
    status,
    channelName: `call_admin_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    callerAgoraUid: 1001,
    calleeAgoraUid: 1002,
    ringExpiresAt: new Date(Date.now() - 60_000),
    ...(status === 'ENDED' || status === 'ACCEPTED' ? { acceptedAt } : {}),
    ...(status === 'ENDED' || status === 'MISSED' || status === 'REJECTED' || status === 'CANCELLED' || status === 'BUSY'
      ? { endedAt }
      : {}),
  });
  return { caller, callee, match, call };
}

describe('admin calls', () => {
  useTestDatabase();

  it('requires ADMIN and returns stats, list, and detail without Agora credentials', async () => {
    const moderator = await createStaff('MODERATOR');
    const forbidden = await request(app).get('/api/v1/admin/calls').set(bearer(moderator.token));
    expect(forbidden.status).toBe(403);

    const { caller, callee, call } = await seedEndedCall({ type: 'VIDEO', status: 'ENDED' });
    await seedEndedCall({ type: 'AUDIO', status: 'MISSED' });

    const admin = await createStaff('ADMIN');

    const stats = await request(app).get('/api/v1/admin/calls/stats?days=7').set(bearer(admin.token));
    expect(stats.status).toBe(200);
    expect(stats.body.data.total).toBeGreaterThanOrEqual(2);
    expect(stats.body.data.video).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.audio).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.byStatus.ENDED).toBeGreaterThanOrEqual(1);
    expect(stats.body.data).not.toHaveProperty('appCertificate');
    expect(stats.body.data).not.toHaveProperty('token');

    const list = await request(app).get('/api/v1/admin/calls?type=VIDEO').set(bearer(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items.some((item) => item.id === String(call._id))).toBe(true);
    const videoRow = list.body.data.items.find((item) => item.id === String(call._id));
    expect(videoRow).toMatchObject({
      type: 'VIDEO',
      status: 'ENDED',
      caller: expect.objectContaining({ id: caller.id }),
      callee: expect.objectContaining({ id: callee.id }),
      durationSeconds: expect.any(Number),
    });
    expect(videoRow).not.toHaveProperty('token');
    expect(videoRow).not.toHaveProperty('callerAgoraUid');

    const detail = await request(app).get(`/api/v1/admin/calls/${call._id}`).set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(String(call._id));
    expect(detail.body.data.conversationId).toBe(call.conversationId);
    expect(detail.body.data).not.toHaveProperty('token');

    const missing = await request(app).get('/api/v1/admin/calls/not-an-id').set(bearer(admin.token));
    expect(missing.status).toBe(404);
  });

  it('filters by status and search query', async () => {
    const admin = await createStaff('ADMIN');
    const { caller, call } = await seedEndedCall({ type: 'AUDIO', status: 'REJECTED' });

    const byStatus = await request(app)
      .get('/api/v1/admin/calls?status=REJECTED')
      .set(bearer(admin.token));
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.data.items.every((item) => item.status === 'REJECTED')).toBe(true);
    expect(byStatus.body.data.items.some((item) => item.id === String(call._id))).toBe(true);

    const byUser = await request(app)
      .get(`/api/v1/admin/calls?q=${encodeURIComponent(caller.id)}`)
      .set(bearer(admin.token));
    expect(byUser.status).toBe(200);
    expect(byUser.body.data.items.some((item) => item.id === String(call._id))).toBe(true);
  });
});
