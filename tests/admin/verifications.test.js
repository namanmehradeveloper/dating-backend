// Tests selfie verification review: queue, signed selfie URL, approve/reject effects on the member,
// notifications, double-review protection and audit entries.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Notification } from '../../src/models/Notification.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { makeImage } from '../helpers/images.js';

const app = createApp();

// Uploads a selfie and submits it for verification; returns the member.
async function memberAwaitingVerification() {
  const member = await createMember({ profile: { displayName: 'Selfie Sam' } });
  const upload = await request(app)
    .post('/api/v1/media/upload')
    .set(bearer(member.token))
    .field('purpose', 'VERIFICATION_SELFIE')
    .attach('file', await makeImage('jpeg'), 'selfie.jpg');
  await request(app).post('/api/v1/profile/verification').set(bearer(member.token)).send({ selfieMediaId: upload.body.data.mediaId });
  return member;
}

// Returns the id of the only pending verification.
async function pendingVerificationId(staff) {
  const res = await request(app).get('/api/v1/admin/verifications?status=PENDING').set(bearer(staff.token));
  return res.body.data.items[0].id;
}

describe('admin verifications', () => {
  useTestDatabase();

  it('lists pending requests and shows a signed selfie URL', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await memberAwaitingVerification();

    const list = await request(app).get('/api/v1/admin/verifications?status=PENDING').set(bearer(moderator.token));
    expect(list.body.data.items).toEqual([
      {
        id: expect.stringMatching(/^ver_/),
        status: 'PENDING',
        user: expect.objectContaining({ id: member.id, displayName: 'Selfie Sam' }),
        submittedAt: expect.any(String),
        reviewedAt: null,
        selfieUrl: expect.stringMatching(/\/uploads\/verification\/.+\?expires=\d+&signature=/),
      },
    ]);

    const byName = await request(app).get('/api/v1/admin/verifications?status=PENDING&q=Selfie').set(bearer(moderator.token));
    expect(byName.body.data.items).toHaveLength(1);
    const miss = await request(app).get('/api/v1/admin/verifications?status=PENDING&q=nobody-here').set(bearer(moderator.token));
    expect(miss.body.data.items).toHaveLength(0);

    const detail = await request(app).get(`/api/v1/admin/verifications/${list.body.data.items[0].id}`).set(bearer(moderator.token));
    expect(detail.body.data.selfieUrl).toMatch(/\/uploads\/verification\/.+\?expires=\d+&signature=/);
    const selfiePath = new URL(detail.body.data.selfieUrl).pathname + new URL(detail.body.data.selfieUrl).search;
    expect((await request(app).get(selfiePath)).status).toBe(200);
  });

  it('approves: member becomes VERIFIED, gets notified, audit entry written', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await memberAwaitingVerification();
    const id = await pendingVerificationId(moderator);

    const res = await request(app).patch(`/api/v1/admin/verifications/${id}`).set(bearer(moderator.token)).send({ status: 'APPROVED' });
    expect(res.body.data).toMatchObject({ status: 'APPROVED', reviewedBy: { id: moderator.id }, reviewedAt: expect.any(String) });
    expect((await User.findById(member.id)).verificationStatus).toBe('VERIFIED');
    expect(await Notification.exists({ userId: member.id, type: 'VERIFICATION_RESULT' })).toBeTruthy();
    expect(await AuditLog.findOne({ action: 'VERIFICATION_REVIEWED', targetId: id })).toMatchObject({ actorId: moderator.id });

    const again = await request(app).patch(`/api/v1/admin/verifications/${id}`).set(bearer(moderator.token)).send({ status: 'REJECTED', reason: 'Changed mind' });
    expect(again.status).toBe(409);
  });

  it('rejects with a required reason', async () => {
    const moderator = await createStaff('MODERATOR');
    const member = await memberAwaitingVerification();
    const id = await pendingVerificationId(moderator);

    const noReason = await request(app).patch(`/api/v1/admin/verifications/${id}`).set(bearer(moderator.token)).send({ status: 'REJECTED' });
    expect(noReason.body.error.details).toEqual([{ field: 'reason', reason: 'REQUIRED' }]);

    await request(app).patch(`/api/v1/admin/verifications/${id}`).set(bearer(moderator.token)).send({ status: 'REJECTED', reason: 'Face not visible' });
    expect((await User.findById(member.id)).verificationStatus).toBe('REJECTED');
  });
});
