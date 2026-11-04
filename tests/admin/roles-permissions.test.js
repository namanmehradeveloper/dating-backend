// Roles & permissions: staff lifecycle, custom roles, matrix, 2FA login, force logout.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { User } from '../../src/models/User.js';
import { ensureSystemRoles } from '../../src/services/rbac.service.js';
import { generateTotpSecret, verifyTotp } from '../../src/services/totp.service.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('admin roles and permissions', () => {
  useTestDatabase();

  it('seeds system roles and returns catalog + stats', async () => {
    const admin = await createStaff('ADMIN');
    await ensureSystemRoles();

    const catalog = await request(app).get('/api/v1/admin/roles/catalog').set(bearer(admin.token));
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.modules).toContain('STAFF');
    expect(catalog.body.data.actions).toEqual(['VIEW', 'CREATE', 'EDIT', 'DELETE']);

    const roles = await request(app).get('/api/v1/admin/roles').set(bearer(admin.token));
    expect(roles.status).toBe(200);
    expect(roles.body.data.items.some((role) => role.slug === 'MODERATOR')).toBe(true);

    const stats = await request(app).get('/api/v1/admin/staff/stats').set(bearer(admin.token));
    expect(stats.status).toBe(200);
    expect(stats.body.data.total).toBeGreaterThanOrEqual(1);
  });

  it('creates a custom role, updates permissions, and blocks delete while assigned', async () => {
    const admin = await createStaff('ADMIN');
    await ensureSystemRoles();

    const created = await request(app)
      .post('/api/v1/admin/roles')
      .set(bearer(admin.token))
      .send({
        name: 'City Ops',
        description: 'Local operators',
        rank: 25,
        permissions: [{ module: 'USERS', actions: ['VIEW', 'EDIT'] }],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.slug).toMatch(/^CUSTOM_/);
    expect(created.body.data.permissions[0].actions).toContain('VIEW');

    const roleId = created.body.data.id;
    const updated = await request(app)
      .put(`/api/v1/admin/roles/${roleId}/permissions`)
      .set(bearer(admin.token))
      .send({ permissions: [{ module: 'SUPPORT', actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'] }] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions.some((entry) => entry.module === 'SUPPORT')).toBe(true);

    const staff = await request(app)
      .post('/api/v1/admin/staff')
      .set(bearer(admin.token))
      .send({ email: 'ops@example.test', password: 'password12345', role: created.body.data.slug });
    expect(staff.status).toBe(201);

    const blocked = await request(app).delete(`/api/v1/admin/roles/${roleId}`).set(bearer(admin.token));
    expect(blocked.status).toBe(409);

    await User.updateOne({ _id: staff.body.data.id }, { role: 'MODERATOR' });
    const deleted = await request(app).delete(`/api/v1/admin/roles/${roleId}`).set(bearer(admin.token));
    expect(deleted.status).toBe(200);
    expect(await AdminRole.findById(roleId)).toBeNull();
  });

  it('prevents assigning Super Admin and managing Super Admin as Admin', async () => {
    const admin = await createStaff('ADMIN');
    const superAdmin = await createStaff('SUPER_ADMIN');
    await ensureSystemRoles();

    const createSuper = await request(app)
      .post('/api/v1/admin/staff')
      .set(bearer(admin.token))
      .send({ email: 'super2@example.test', password: 'password12345', role: 'SUPER_ADMIN' });
    expect(createSuper.status).toBe(403);

    const touchSuper = await request(app)
      .patch(`/api/v1/admin/staff/${superAdmin.id}/role`)
      .set(bearer(admin.token))
      .send({ role: 'MODERATOR' });
    expect(touchSuper.status).toBe(403);
  });

  it('suspends staff, lists sessions, and force-logs out with audit', async () => {
    const admin = await createStaff('ADMIN');
    const mod = await createStaff('MODERATOR');
    await ensureSystemRoles();

    const suspended = await request(app)
      .patch(`/api/v1/admin/staff/${mod.id}/status`)
      .set(bearer(admin.token))
      .send({ status: 'SUSPENDED', reason: 'Policy breach review' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.status).toBe('SUSPENDED');

    const sessions = await request(app).get(`/api/v1/admin/staff/${mod.id}/sessions`).set(bearer(admin.token));
    expect(sessions.status).toBe(200);
    expect(sessions.body.data).toHaveProperty('items');

    await User.updateOne({ _id: mod.id }, { status: 'ACTIVE' });
    const forced = await request(app)
      .post(`/api/v1/admin/staff/${mod.id}/force-logout`)
      .set(bearer(admin.token))
      .send({ reason: 'Credential rotation' });
    expect(forced.status).toBe(200);

    expect(await AuditLog.findOne({ action: 'STAFF_FORCE_LOGOUT', targetId: mod.id })).toBeTruthy();
  });

  it('requires 2FA challenge on login when enabled', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const { completeTwoFactorLogin, signInWithEmail } = await import('../../src/services/auth.service.js');
    const { generateTotpCode } = await import('../../src/services/totp.service.js');
    const secret = generateTotpSecret();
    const account = await User.create({
      email: '2fa.staff@example.test',
      passwordHash: await bcrypt.hash('password12345', 4),
      role: 'ADMIN',
      onboardingComplete: true,
      twoFactor: { enabled: true, secret, backupCodes: [] },
    });

    const challenge = await signInWithEmail({ email: account.email, password: 'password12345' });
    expect(challenge.requiresTwoFactor).toBe(true);
    expect(challenge.pendingToken).toBeTruthy();

    const code = generateTotpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);

    const finished = await completeTwoFactorLogin({ pendingToken: challenge.pendingToken, code });
    expect(finished.tokens.accessToken).toBeTruthy();
    expect(finished.user.role).toBe('ADMIN');
  });

  it('rejects members on staff and roles routes', async () => {
    const member = await createMember();
    for (const path of ['/admin/staff', '/admin/roles', '/admin/roles/catalog', '/admin/staff/stats']) {
      const res = await request(app).get(`/api/v1${path}`).set(bearer(member.token));
      expect(res.status, path).toBe(403);
    }
  });
});
