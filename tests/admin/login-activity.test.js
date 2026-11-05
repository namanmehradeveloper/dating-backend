import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { LoginHistory } from '../../src/models/LoginHistory.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

function loginEntry(userId, loginAt, ipAddress) {
  return LoginHistory.create({
    userId,
    loginAt,
    ipAddress,
    country: 'Canada',
    state: 'Ontario',
    city: 'Toronto',
    deviceName: 'Windows PC',
    deviceType: 'DESKTOP',
    browser: 'Chrome',
    operatingSystem: 'Windows',
  });
}

describe('GET /profile/login-activity', () => {
  useTestDatabase();

  it('returns only records belonging to the authenticated user', async () => {
    const member = await createMember();
    const otherMember = await createMember();
    await loginEntry(member.id, new Date('2026-10-10T12:00:00.000Z'), '203.0.113.1');
    await loginEntry(otherMember.id, new Date('2026-10-11T12:00:00.000Z'), '203.0.113.2');

    const response = await request(app)
      .get('/api/v1/profile/login-activity')
      .set(bearer(member.token));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      ipAddress: '203.0.113.1',
      country: 'Canada',
      state: 'Ontario',
      city: 'Toronto',
    });
    expect(response.body.data.items[0].userId).toBeUndefined();
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/v1/profile/login-activity');
    expect(response.status).toBe(401);
  });
});

describe('GET /admin/login-activity', () => {
  useTestDatabase();

  it('searches users, applies inclusive date filters and returns user cards', async () => {
    const admin = await createStaff('ADMIN');
    const target = await createMember({ profile: { displayName: 'Login Activity Target' } });
    const other = await createMember({ profile: { displayName: 'Another Member' } });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await loginEntry(target.id, new Date(`${today}T12:00:00.000Z`), '203.0.113.5');
    await loginEntry(target.id, new Date(`${today}T11:00:00.000Z`), '203.0.113.8');
    await loginEntry(target.id, new Date(`${yesterday}T12:00:00.000Z`), '203.0.113.6');
    await loginEntry(other.id, new Date(`${today}T13:00:00.000Z`), '203.0.113.7');

    const query = { q: 'Login Activity Target', fromDate: today, toDate: today, limit: 1 };
    const response = await request(app)
      .get('/api/v1/admin/login-activity')
      .query(query)
      .set(bearer(admin.token));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.nextCursor).toEqual(expect.any(String));
    expect(response.body.data.items[0]).toMatchObject({
      user: { id: target.id, displayName: 'Login Activity Target' },
      ipAddress: '203.0.113.5',
    });

    const nextPage = await request(app)
      .get('/api/v1/admin/login-activity')
      .query({ ...query, cursor: response.body.data.nextCursor })
      .set(bearer(admin.token));
    expect(nextPage.body.data.items).toHaveLength(1);
    expect(nextPage.body.data.items[0].ipAddress).toBe('203.0.113.8');
  });

  it('enforces the existing AUDIT_LOGS.VIEW permission', async () => {
    const moderator = await createStaff('MODERATOR');
    const response = await request(app)
      .get('/api/v1/admin/login-activity')
      .set(bearer(moderator.token));
    expect(response.status).toBe(403);
  });

  it('rejects reversed date ranges', async () => {
    const admin = await createStaff('ADMIN');
    const response = await request(app)
      .get('/api/v1/admin/login-activity')
      .query({ fromDate: '2026-10-10', toDate: '2026-10-09' })
      .set(bearer(admin.token));
    expect(response.status).toBe(400);
  });
});
