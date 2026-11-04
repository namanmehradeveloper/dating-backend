// Tests admin notification campaigns: audiences, promotion opt-in, honest push status,
// single-member targeting, validation and audit entries.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Notification } from '../../src/models/Notification.js';
import { NotificationPreference } from '../../src/models/NotificationPreference.js';
import { bearer, createMember, createStaff, grantPremium, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

// Sends a campaign as the given staff member.
function sendCampaign(staff, body) {
  return request(app).post('/api/v1/admin/notifications').set(bearer(staff.token)).send(body);
}

describe('admin notifications', () => {
  useTestDatabase();

  it('sends an announcement to all members (not banned ones, not staff) and records it', async () => {
    const admin = await createStaff('ADMIN');
    const first = await createMember();
    const second = await createMember();
    await createMember({ user: { status: 'BANNED' } });

    const res = await sendCampaign(admin, { title: 'New feature', body: 'Try video prompts!', type: 'ANNOUNCEMENT', audience: 'ALL_USERS' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ audience: 'ALL_USERS', recipientCount: 2, pushStatus: 'FEATURE_NOT_CONFIGURED', createdBy: { id: admin.id } });

    const inbox = await request(app).get('/api/v1/notifications').set(bearer(first.token));
    expect(inbox.body.data.items).toEqual([expect.objectContaining({ type: 'SYSTEM', title: 'New feature', data: { campaignId: res.body.data.id } })]);
    expect(await Notification.countDocuments({ userId: second.id })).toBe(1);
    expect(await AuditLog.findOne({ action: 'NOTIFICATION_SENT' })).toMatchObject({ actorId: admin.id, targetId: res.body.data.id });

    const list = await request(app).get('/api/v1/admin/notifications').set(bearer(admin.token));
    expect(list.body.data.items.map((campaign) => campaign.id)).toEqual([res.body.data.id]);
    const found = await request(app).get('/api/v1/admin/notifications?q=video').set(bearer(admin.token));
    expect(found.body.data.items).toHaveLength(1);
    const miss = await request(app).get('/api/v1/admin/notifications?q=unrelated-term').set(bearer(admin.token));
    expect(miss.body.data.items).toHaveLength(0);
  });

  it('targets premium and verified members', async () => {
    const admin = await createStaff('ADMIN');
    const premium = await createMember();
    await grantPremium(premium.id);
    await createMember({ user: { verificationStatus: 'VERIFIED' } });
    await createMember();

    const toPremium = await sendCampaign(admin, { title: 'Thanks', body: 'Enjoy Plus', type: 'ANNOUNCEMENT', audience: 'PREMIUM_USERS' });
    expect(toPremium.body.data.recipientCount).toBe(1);
    const toFree = await sendCampaign(admin, { title: 'Upgrade', body: 'Plus is here', type: 'ANNOUNCEMENT', audience: 'FREE_USERS' });
    expect(toFree.body.data.recipientCount).toBe(2);
    const toVerified = await sendCampaign(admin, { title: 'Verified', body: 'Hi', type: 'ANNOUNCEMENT', audience: 'VERIFIED_USERS' });
    expect(toVerified.body.data.recipientCount).toBe(1);
  });

  it('delivers promotions only to members who opted in', async () => {
    const admin = await createStaff('ADMIN');
    const optedIn = await createMember();
    await createMember();
    await NotificationPreference.create({ userId: optedIn.id, promotions: true });

    const res = await sendCampaign(admin, { title: 'Sale', body: '50% off Plus', type: 'PROMOTION', audience: 'ALL_USERS' });
    expect(res.body.data.recipientCount).toBe(1);
    expect(await Notification.exists({ userId: optedIn.id })).toBeTruthy();
  });

  it('sends to a single member and validates the target', async () => {
    const admin = await createStaff('ADMIN');
    const member = await createMember();

    const res = await sendCampaign(admin, { title: 'Hello', body: 'Just for you', type: 'ANNOUNCEMENT', audience: 'SINGLE_USER', targetUserId: member.id });
    expect(res.body.data).toMatchObject({ recipientCount: 1, targetUserId: member.id });

    const missing = await sendCampaign(admin, { title: 'Hello', body: 'Hi', type: 'ANNOUNCEMENT', audience: 'SINGLE_USER' });
    expect(missing.body.error.details).toEqual([{ field: 'targetUserId', reason: 'REQUIRED' }]);
    const unknown = await sendCampaign(admin, { title: 'Hello', body: 'Hi', type: 'ANNOUNCEMENT', audience: 'SINGLE_USER', targetUserId: 'usr_000000000000000000000000' });
    expect(unknown.status).toBe(404);
    const invalid = await sendCampaign(admin, { title: '', body: 'x'.repeat(501), type: 'SPAM', audience: 'EVERYONE' });
    expect(invalid.body.error.details.map((detail) => detail.field)).toEqual(['title', 'body', 'type', 'audience']);
  });
});
