// Tests the moderation queue: listing and filtering, report details with the reported content,
// status changes with history, closed reports, and audit entries.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

// Files a report about `target` from `reporter` through the member API.
async function fileReport(reporter, target, reason = 'FAKE_PROFILE') {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(bearer(reporter.token))
    .send({ targetType: 'USER', targetId: target.id, reason, details: 'Looks fake', alsoBlock: false });
  return res.body.data;
}

describe('admin reports', () => {
  useTestDatabase();

  it('lists reports with reporter and reported member, filtered by status', async () => {
    const moderator = await createStaff('MODERATOR');
    const reporter = await createMember({ profile: { displayName: 'Reporter' } });
    const target = await createMember({ profile: { displayName: 'Target' } });
    const report = await fileReport(reporter, target);

    const res = await request(app).get('/api/v1/admin/reports?status=OPEN').set(bearer(moderator.token));
    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        id: report.id,
        targetType: 'USER',
        reason: 'FAKE_PROFILE',
        status: 'OPEN',
        reporter: expect.objectContaining({ id: reporter.id, displayName: 'Reporter' }),
        reportedUser: expect.objectContaining({ id: target.id, displayName: 'Target' }),
        assignedModerator: null,
      }),
    ]);
    expect((await request(app).get('/api/v1/admin/reports?status=DISMISSED').set(bearer(moderator.token))).body.data.items).toEqual([]);
  });

  it('shows the reported message text', async () => {
    const moderator = await createStaff('MODERATOR');
    const alex = await createMember();
    const avery = await createMember();
    const match = await matchMembers(app, alex, avery);
    const clientMessageId = uuidv4();
    const message = (
      await request(app)
        .post(`/api/v1/conversations/${match.conversationId}/messages`)
        .set(bearer(avery.token))
        .set('Idempotency-Key', clientMessageId)
        .send({ text: 'Send me money', clientMessageId })
    ).body.data;
    const report = (await request(app).post(`/api/v1/messages/${message.id}/report`).set(bearer(alex.token)).send({ reason: 'SPAM_OR_SCAM' })).body.data;

    const res = await request(app).get(`/api/v1/admin/reports/${report.id}`).set(bearer(moderator.token));
    expect(res.body.data).toMatchObject({ targetType: 'MESSAGE', content: { text: 'Send me money' }, history: [{ status: 'OPEN' }] });
  });

  it('moves a report through review to a decision, keeping history and audit entries', async () => {
    const moderator = await createStaff('MODERATOR');
    const report = await fileReport(await createMember(), await createMember());

    const review = await request(app).patch(`/api/v1/admin/reports/${report.id}`).set(bearer(moderator.token)).send({ status: 'IN_REVIEW' });
    expect(review.body.data).toMatchObject({ status: 'IN_REVIEW', assignedModerator: { id: moderator.id } });

    const actioned = await request(app)
      .patch(`/api/v1/admin/reports/${report.id}`)
      .set(bearer(moderator.token))
      .send({ status: 'ACTIONED', resolutionNote: 'Suspended the account' });
    expect(actioned.body.data).toMatchObject({ status: 'ACTIONED', resolutionNote: 'Suspended the account', resolvedAt: expect.any(String) });
    expect(actioned.body.data.history.map((entry) => entry.status)).toEqual(['OPEN', 'IN_REVIEW', 'ACTIONED']);

    const reopen = await request(app).patch(`/api/v1/admin/reports/${report.id}`).set(bearer(moderator.token)).send({ status: 'IN_REVIEW' });
    expect(reopen.status).toBe(409);

    const audits = await AuditLog.find({ action: 'REPORT_UPDATED', targetId: report.id }).sort({ createdAt: 1 });
    expect(audits.map((audit) => audit.metadata.to)).toEqual(['IN_REVIEW', 'ACTIONED']);
  });

  it('validates the update', async () => {
    const moderator = await createStaff('MODERATOR');
    const report = await fileReport(await createMember(), await createMember());
    const patch = (body) => request(app).patch(`/api/v1/admin/reports/${report.id}`).set(bearer(moderator.token)).send(body);

    expect((await patch({})).body.error.details).toEqual([{ field: 'body', reason: 'NO_FIELDS' }]);
    expect((await patch({ status: 'OPEN' })).body.error.details).toEqual([{ field: 'status', reason: 'UNKNOWN_OPTION' }]);
    expect((await request(app).patch('/api/v1/admin/reports/rep_000000000000000000000000').set(bearer(moderator.token)).send({ status: 'DISMISSED' })).status).toBe(404);
  });
});
