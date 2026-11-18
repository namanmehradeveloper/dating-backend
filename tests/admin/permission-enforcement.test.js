// Verifies requirePermission for every system role across VIEW/CREATE/EDIT/DELETE,
// including custom roles and immediate matrix updates.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AdminRole } from '../../src/models/AdminRole.js';
import { ensureSystemRoles, hasPermission } from '../../src/services/rbac.service.js';
import { bearer, createStaff, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

const ROLE_CASES = [
  {
    role: 'SUPER_ADMIN',
    allow: [
      ['get', '/admin/users', 200],
      ['post', '/admin/users', null],
      ['get', '/admin/payments', 200],
      ['get', '/admin/staff', 200],
      ['delete', '/admin/roles/rol_missing', null],
    ],
    deny: [],
  },
  {
    role: 'ADMIN',
    allow: [
      ['get', '/admin/users', 200],
      ['post', '/admin/users', null],
      ['get', '/admin/payments', 200],
      ['get', '/admin/staff', 200],
      ['get', '/admin/roles', 200],
    ],
    deny: [],
  },
  {
    role: 'MODERATOR',
    allow: [
      ['get', '/admin/users', 200],
      ['patch', '/admin/users/usr_000000000000000000000000/status', null],
      ['get', '/admin/reports', 200],
    ],
    deny: [
      ['post', '/admin/users'],
      ['get', '/admin/payments'],
      ['get', '/admin/staff'],
      ['post', '/admin/notifications'],
    ],
  },
  {
    role: 'SUPPORT_AGENT',
    allow: [
      ['get', '/admin/support/tickets', 200],
      ['get', '/admin/users', 200],
    ],
    deny: [
      ['post', '/admin/users'],
      ['patch', '/admin/users/usr_000000000000000000000000/status'],
      ['get', '/admin/payments'],
      ['get', '/admin/cms'],
    ],
  },
  {
    role: 'FINANCE_MANAGER',
    allow: [
      ['get', '/admin/payments', 200],
      ['get', '/admin/subscriptions', 200],
      ['get', '/admin/coupons', 200],
      ['get', '/admin/users', 200],
    ],
    deny: [
      ['post', '/admin/users'],
      ['get', '/admin/staff'],
      ['post', '/admin/cms'],
      ['patch', '/admin/users/usr_000000000000000000000000/status'],
    ],
  },
  {
    role: 'MARKETING_MANAGER',
    allow: [
      ['get', '/admin/cms', 200],
      ['post', '/admin/cms', null],
      ['get', '/admin/experiments', 200],
      ['get', '/admin/notifications', 200],
    ],
    deny: [
      ['get', '/admin/payments'],
      ['get', '/admin/staff'],
      ['patch', '/admin/users/usr_000000000000000000000000/status'],
    ],
  },
  {
    role: 'ANALYST',
    allow: [
      ['get', '/admin/analytics', 200],
      ['get', '/admin/users', 200],
      ['get', '/admin/monitoring', 200],
    ],
    deny: [
      ['post', '/admin/users'],
      ['patch', '/admin/users/usr_000000000000000000000000/status'],
      ['get', '/admin/payments'],
      ['post', '/admin/cms'],
      ['get', '/admin/staff'],
    ],
  },
];

describe('permission enforcement by role', () => {
  useTestDatabase();

  it.each(ROLE_CASES)('$role receives catalog-aligned API access', async ({ role, allow, deny }) => {
    await ensureSystemRoles();
    const staff = await createStaff(role);

    for (const [method, path] of allow) {
      const res = await request(app)[method](`/api/v1${path}`).set(bearer(staff.token)).send({});
      expect(res.status, `${role} allow ${method} ${path}`).not.toBe(403);
    }

    for (const [method, path] of deny) {
      const res = await request(app)[method](`/api/v1${path}`).set(bearer(staff.token)).send({});
      expect(res.status, `${role} deny ${method} ${path}`).toBe(403);
    }
  });

  it('applies custom role permissions and updates immediately without re-login', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');

    const created = await request(app)
      .post('/api/v1/admin/roles')
      .set(bearer(admin.token))
      .send({
        name: 'View Only Ops',
        rank: 20,
        permissions: [{ module: 'USERS', actions: ['VIEW'] }],
      });
    expect(created.status).toBe(201);
    const roleSlug = created.body.data.slug;
    const roleId = created.body.data.id;

    const custom = await createStaff(roleSlug);
    expect((await request(app).get('/api/v1/admin/users').set(bearer(custom.token))).status).not.toBe(403);
    expect((await request(app).post('/api/v1/admin/users').set(bearer(custom.token)).send({})).status).toBe(403);

    const updated = await request(app)
      .put(`/api/v1/admin/roles/${roleId}/permissions`)
      .set(bearer(admin.token))
      .send({ permissions: [{ module: 'USERS', actions: ['VIEW', 'CREATE'] }] });
    expect(updated.status).toBe(200);

    // Same token — permissions are re-read from AdminRole on every request.
    const createAttempt = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(custom.token))
      .send({
        phoneNumber: '+919800001111',
        displayName: 'Temp',
        dateOfBirth: '1995-01-01',
        gender: 'WOMAN',
        showMe: 'EVERYONE',
      });
    expect(createAttempt.status).not.toBe(403);

    const roleDoc = await AdminRole.findById(roleId).lean();
    expect(hasPermission(roleDoc.permissions, 'USERS', 'CREATE')).toBe(true);
    expect(hasPermission(roleDoc.permissions, 'USERS', 'DELETE')).toBe(false);
  });

  it('loads selected role permissions from the database for the matrix API', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const roles = await request(app).get('/api/v1/admin/roles').set(bearer(admin.token));
    expect(roles.status).toBe(200);
    const support = roles.body.data.items.find((item) => item.slug === 'SUPPORT_AGENT');
    expect(support).toBeTruthy();

    const detail = await request(app).get(`/api/v1/admin/roles/${support.id}`).set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'SUPPORT', actions: expect.arrayContaining(['VIEW', 'CREATE', 'EDIT', 'DELETE']) }),
        expect.objectContaining({ module: 'USERS', actions: ['VIEW'] }),
      ]),
    );
    expect(detail.body.data.permissions.some((entry) => entry.module === 'PAYMENTS')).toBe(false);
  });

  it('saves matrix edits, reloads them from AdminRole, and revokes staff access immediately', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const supportStaff = await createStaff('SUPPORT_AGENT');

    const roles = await request(app).get('/api/v1/admin/roles').set(bearer(admin.token));
    const support = roles.body.data.items.find((item) => item.slug === 'SUPPORT_AGENT');
    expect(support).toBeTruthy();

    expect((await request(app).get('/api/v1/admin/support/tickets').set(bearer(supportStaff.token))).status).not.toBe(403);

    const reduced = [
      { module: 'DASHBOARD', actions: ['VIEW'] },
      { module: 'USERS', actions: ['VIEW'] },
      { module: 'SUPPORT', actions: ['VIEW'] },
    ];
    const updated = await request(app)
      .put(`/api/v1/admin/roles/${support.id}/permissions`)
      .set(bearer(admin.token))
      .send({ permissions: reduced });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'SUPPORT', actions: ['VIEW'] }),
        expect.objectContaining({ module: 'USERS', actions: ['VIEW'] }),
      ]),
    );
    expect(updated.body.data.permissions.find((entry) => entry.module === 'SUPPORT').actions).not.toContain('EDIT');
    expect(updated.body.data.permissions.find((entry) => entry.module === 'SUPPORT').actions).not.toContain('CREATE');

    const reloaded = await request(app).get(`/api/v1/admin/roles/${support.id}`).set(bearer(admin.token));
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data.permissions).toEqual(updated.body.data.permissions);

    // Ticket list still allowed (VIEW); replies require EDIT and must be revoked without re-login.
    expect((await request(app).get('/api/v1/admin/support/tickets').set(bearer(supportStaff.token))).status).not.toBe(403);
    const reply = await request(app)
      .post('/api/v1/admin/support/tickets/tkt_000000000000000000000000/messages')
      .set(bearer(supportStaff.token))
      .send({ body: 'hello' });
    expect(reply.status).toBe(403);

    const me = await request(app).get('/api/v1/admin/me').set(bearer(supportStaff.token));
    expect(me.status).toBe(200);
    expect(me.body.data.permissionKeys).toContain('SUPPORT.VIEW');
    expect(me.body.data.permissionKeys).not.toContain('SUPPORT.EDIT');
    expect(me.body.data.permissionKeys).not.toContain('SUPPORT.CREATE');
  });

  it('keeps intentional system-role permission edits across ensureSystemRoles', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const roles = await request(app).get('/api/v1/admin/roles').set(bearer(admin.token));
    const finance = roles.body.data.items.find((item) => item.slug === 'FINANCE_MANAGER');
    expect(finance).toBeTruthy();

    const trimmed = [
      { module: 'DASHBOARD', actions: ['VIEW'] },
      { module: 'PAYMENTS', actions: ['VIEW', 'EDIT'] },
    ];
    const updated = await request(app)
      .put(`/api/v1/admin/roles/${finance.id}/permissions`)
      .set(bearer(admin.token))
      .send({ permissions: trimmed });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toHaveLength(2);

    await ensureSystemRoles();
    await ensureSystemRoles();

    const afterSeed = await AdminRole.findById(finance.id).lean();
    expect(afterSeed.permissions).toHaveLength(2);
    expect(hasPermission(afterSeed.permissions, 'PAYMENTS', 'EDIT')).toBe(true);
    expect(hasPermission(afterSeed.permissions, 'SUBSCRIPTIONS', 'VIEW')).toBe(false);

    const detail = await request(app).get(`/api/v1/admin/roles/${finance.id}`).set(bearer(admin.token));
    expect(detail.body.data.permissions).toHaveLength(2);
  });

  it('allows ROLES.EDIT holders below ADMIN rank to update lower-ranked role matrices', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');

    const created = await request(app)
      .post('/api/v1/admin/roles')
      .set(bearer(admin.token))
      .send({
        name: 'Role Editors',
        rank: 25,
        permissions: [
          { module: 'DASHBOARD', actions: ['VIEW'] },
          { module: 'ROLES', actions: ['VIEW', 'EDIT'] },
          { module: 'STAFF', actions: ['VIEW'] },
        ],
      });
    expect(created.status).toBe(201);

    const target = await request(app)
      .post('/api/v1/admin/roles')
      .set(bearer(admin.token))
      .send({
        name: 'City Desk',
        rank: 15,
        permissions: [{ module: 'USERS', actions: ['VIEW'] }],
      });
    expect(target.status).toBe(201);

    const editor = await createStaff(created.body.data.slug);
    const saved = await request(app)
      .put(`/api/v1/admin/roles/${target.body.data.id}/permissions`)
      .set(bearer(editor.token))
      .send({ permissions: [{ module: 'USERS', actions: ['VIEW', 'EDIT'] }] });
    expect(saved.status).toBe(200);
    expect(hasPermission(saved.body.data.permissions, 'USERS', 'EDIT')).toBe(true);

    const blocked = await request(app)
      .put(`/api/v1/admin/roles/${created.body.data.id}/permissions`)
      .set(bearer(editor.token))
      .send({ permissions: [{ module: 'DASHBOARD', actions: ['VIEW'] }] });
    expect(blocked.status).toBe(403);
  });

  it('blocks non-super-admins from changing Super Admin permissions', async () => {
    await ensureSystemRoles();
    const admin = await createStaff('ADMIN');
    const roles = await request(app).get('/api/v1/admin/roles').set(bearer(admin.token));
    const superRole = roles.body.data.items.find((item) => item.slug === 'SUPER_ADMIN');
    expect(superRole).toBeTruthy();

    const attempt = await request(app)
      .put(`/api/v1/admin/roles/${superRole.id}/permissions`)
      .set(bearer(admin.token))
      .send({ permissions: [{ module: 'DASHBOARD', actions: ['VIEW'] }] });
    expect(attempt.status).toBe(403);
  });
});
