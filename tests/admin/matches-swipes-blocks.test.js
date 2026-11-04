// Tests admin matches, swipes, blocks, messaging, analytics and profiles (happy paths + auth).

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Message } from '../../src/models/Message.js';
import { Swipe } from '../../src/models/Swipe.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers, swipe } from '../helpers/social.js';

const app = createApp();

describe('admin matches, swipes and blocks', () => {
  useTestDatabase();

  it('lists matches with user cards and messageCount (no message text)', async () => {
    const admin = await createStaff('ADMIN');
    const a = await createMember({ user: { email: 'ava.search@example.test' }, profile: { displayName: 'Ava' } });
    const b = await createMember({ profile: { displayName: 'Ben' } });
    const match = await matchMembers(app, a, b);
    await Message.create({ conversationId: match.conversationId, senderId: a.id, text: 'secret hello' });

    const res = await request(app).get('/api/v1/admin/matches').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      id: match.id,
      status: 'ACTIVE',
      messageCount: 1,
    });
    expect(res.body.data.items[0].users).toHaveLength(2);
    expect(JSON.stringify(res.body.data)).not.toContain('secret hello');

    const byEmail = await request(app).get('/api/v1/admin/matches?q=ava.search@example.test').set(bearer(admin.token));
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.items).toHaveLength(1);

    const byName = await request(app).get('/api/v1/admin/matches?q=Ava').set(bearer(admin.token));
    expect(byName.status).toBe(200);
    expect(byName.body.data.items).toHaveLength(1);

    const stats = await request(app).get('/api/v1/admin/matches/stats?days=7').set(bearer(admin.token));
    expect(stats.body.data).toMatchObject({
      total: 1,
      active: 1,
      newInRange: 1,
      chatsStarted: 1,
      newToday: 1,
      unmatched: 0,
      expired: 0,
    });
    expect(stats.body.data).toHaveProperty('inactive');
    expect(stats.body.data).toHaveProperty('matchToChatConversion');
    expect(stats.body.data.config).toHaveProperty('matchAlgorithmVersion');

    const analytics = await request(app).get('/api/v1/admin/matches/analytics?days=7').set(bearer(admin.token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.series).toHaveLength(7);
    expect(analytics.body.data).toHaveProperty('algorithmPerformance');
    expect(analytics.body.data).toHaveProperty('weekly');
    expect(analytics.body.data).toHaveProperty('monthly');

    const detail = await request(app).get(`/api/v1/admin/matches/${match.id}`).set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: match.id, messageCount: 1, chatStarted: true });
    expect(detail.body.data.users).toHaveLength(2);
    expect(detail.body.data).toHaveProperty('statusHistory');
    expect(detail.body.data.algorithmVersion).toMatch(/^v/);

    const reported = await request(app).get('/api/v1/admin/matches/reported').set(bearer(admin.token));
    expect(reported.status).toBe(200);
    expect(Array.isArray(reported.body.data.items)).toBe(true);
  });

  it('exposes match config, suspicious queue and admin end to ADMIN', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const a = await createMember();
    const b = await createMember();
    const match = await matchMembers(app, a, b);

    const deniedConfig = await request(app).get('/api/v1/admin/matches/config').set(bearer(moderator.token));
    expect(deniedConfig.status).toBe(403);

    const config = await request(app).get('/api/v1/admin/matches/config').set(bearer(admin.token));
    expect(config.status).toBe(200);
    expect(config.body.data.settings.some((setting) => setting.key === 'matchExpiryDays')).toBe(true);

    const updated = await request(app)
      .patch('/api/v1/admin/matches/config')
      .set(bearer(admin.token))
      .send({ matchExpiryDays: 14, matchFraudNewMatchesPerDay: 10 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.settings.find((setting) => setting.key === 'matchExpiryDays').value).toBe(14);

    const suspicious = await request(app).get('/api/v1/admin/matches/suspicious').set(bearer(admin.token));
    expect(suspicious.status).toBe(200);
    expect(suspicious.body.data).toHaveProperty('threshold');
    expect(Array.isArray(suspicious.body.data.velocity)).toBe(true);
    expect(Array.isArray(suspicious.body.data.quickUnmatches)).toBe(true);

    const ended = await request(app)
      .post(`/api/v1/admin/matches/${match.id}/end`)
      .set(bearer(admin.token))
      .send({ reason: 'MODERATION' });
    expect(ended.status).toBe(200);
    expect(ended.body.data.status).toBe('ENDED');
    expect(ended.body.data.endedReason).toBe('MODERATION');

    const list = await request(app).get('/api/v1/admin/matches?bucket=unmatched').set(bearer(admin.token));
    expect(list.status).toBe(200);
  });

  it('returns swipe stats to staff and swipe list only to ADMIN with userId', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const a = await createMember();
    const b = await createMember();
    await swipe(app, a, b.id, 'LIKE');
    await swipe(app, a, (await createMember()).id, 'PASS');

    const stats = await request(app).get('/api/v1/admin/swipes/stats?days=7').set(bearer(moderator.token));
    expect(stats.status).toBe(200);
    expect(stats.body.data.likes).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.passes).toBeGreaterThanOrEqual(1);

    const denied = await request(app).get(`/api/v1/admin/swipes?userId=${a.id}`).set(bearer(moderator.token));
    expect(denied.status).toBe(403);

    const missing = await request(app).get('/api/v1/admin/swipes').set(bearer(admin.token));
    expect(missing.status).toBe(400);

    const list = await request(app).get(`/api/v1/admin/swipes?userId=${a.id}`).set(bearer(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBeGreaterThanOrEqual(2);
    expect(list.body.data.items[0]).toHaveProperty('user');
    expect(list.body.data.items[0]).toHaveProperty('targetUser');

    expect(stats.body.data).toHaveProperty('priorityLikes');
    expect(stats.body.data).toHaveProperty('entitlements');
    expect(stats.body.data.entitlements).toHaveProperty('freeDailyLikes');

    const analytics = await request(app).get('/api/v1/admin/swipes/analytics?days=7').set(bearer(moderator.token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.series.length).toBe(7);
    expect(analytics.body.data).toHaveProperty('recommendationPerformance');

    const report = await request(app).get(`/api/v1/admin/swipes/members/${a.id}/report`).set(bearer(admin.token));
    expect(report.status).toBe(200);
    expect(report.body.data.totals.likesSent).toBeGreaterThanOrEqual(1);
    expect(report.body.data.totals.passesSent).toBeGreaterThanOrEqual(1);
    expect(report.body.data.limits).toHaveProperty('freeDailyRewinds');

    const entitlements = await request(app).get('/api/v1/admin/swipes/entitlements').set(bearer(admin.token));
    expect(entitlements.status).toBe(200);
    expect(entitlements.body.data.settings.some((setting) => setting.key === 'swipeAbuseThresholdPerDay')).toBe(true);

    const updated = await request(app)
      .patch('/api/v1/admin/swipes/entitlements')
      .set(bearer(admin.token))
      .send({ freeDailyRewinds: 2, swipeAbuseThresholdPerDay: 50 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.settings.find((setting) => setting.key === 'freeDailyRewinds').value).toBe(2);

    const abuse = await request(app).get('/api/v1/admin/swipes/abuse').set(bearer(admin.token));
    expect(abuse.status).toBe(200);
    expect(abuse.body.data).toHaveProperty('threshold');
    expect(Array.isArray(abuse.body.data.items)).toBe(true);

    const passes = await request(app)
      .get(`/api/v1/admin/swipes?userId=${a.id}&action=PASS&direction=sent`)
      .set(bearer(admin.token));
    expect(passes.status).toBe(200);
    expect(passes.body.data.items.every((item) => item.action === 'PASS')).toBe(true);
  });

  it('lists blocks and block stats', async () => {
    const admin = await createStaff('ADMIN');
    const moderator = await createStaff('MODERATOR');
    const a = await createMember({ profile: { displayName: 'Blocker' } });
    const b = await createMember({ profile: { displayName: 'Blocked' } });
    await Block.create({ blockerId: a.id, blockedId: b.id });
    await Block.create({ blockerId: b.id, blockedId: a.id });

    const list = await request(app).get('/api/v1/admin/blocks').set(bearer(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.items[0]).toHaveProperty('mutual', true);
    expect(list.body.data.items.some((item) => item.blocker.displayName === 'Blocker')).toBe(true);

    const stats = await request(app).get('/api/v1/admin/blocks/stats').set(bearer(admin.token));
    expect(stats.body.data).toMatchObject({ total: 2, newInRange: 2, mutualBlocks: 1 });
    expect(stats.body.data).toHaveProperty('uniqueBlockers');
    expect(stats.body.data).toHaveProperty('abuseThreshold');

    const analytics = await request(app).get('/api/v1/admin/blocks/analytics?days=7').set(bearer(moderator.token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.series).toHaveLength(7);
    expect(analytics.body.data).toHaveProperty('topBlockers');

    const detail = await request(app).get(`/api/v1/admin/blocks/${list.body.data.items[0].id}`).set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.mutual).toBe(true);
    expect(detail.body.data).toHaveProperty('policyNote');

    const report = await request(app).get(`/api/v1/admin/blocks/members/${a.id}/report`).set(bearer(admin.token));
    expect(report.status).toBe(200);
    expect(report.body.data.totals.blocksSent).toBe(1);
    expect(report.body.data.totals.blocksReceived).toBe(1);

    expect((await request(app).get('/api/v1/admin/blocks/velocity').set(bearer(moderator.token))).status).toBe(403);
    const velocity = await request(app).get('/api/v1/admin/blocks/velocity').set(bearer(admin.token));
    expect(velocity.status).toBe(200);
    expect(velocity.body.data).toHaveProperty('threshold');
  });

  it('returns messaging and analytics stats without message bodies', async () => {
    const admin = await createStaff('ADMIN');
    const a = await createMember();
    const b = await createMember();
    const match = await matchMembers(app, a, b);
    await Message.create({ conversationId: match.conversationId, senderId: a.id, text: 'private chat' });

    const messaging = await request(app).get('/api/v1/admin/messaging/stats').set(bearer(admin.token));
    expect(messaging.status).toBe(200);
    expect(messaging.body.data.messageCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(messaging.body.data)).not.toContain('private chat');

    const analytics = await request(app).get('/api/v1/admin/analytics?days=7').set(bearer(admin.token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data).toHaveProperty('dauApprox');
    expect(analytics.body.data).toHaveProperty('matchTotals');
    expect(analytics.body.data).toHaveProperty('dashboard');
  });

  it('rejects members on matches/swipes/blocks routes', async () => {
    const member = await createMember();
    for (const path of [
      '/admin/matches',
      '/admin/matches/stats',
      '/admin/matches/analytics',
      '/admin/swipes/stats',
      '/admin/blocks',
      '/admin/blocks/stats',
    ]) {
      const res = await request(app).get(`/api/v1${path}`).set(bearer(member.token));
      expect(res.status, path).toBe(403);
    }
  });
});
