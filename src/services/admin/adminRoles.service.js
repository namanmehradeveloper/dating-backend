// Custom and system role CRUD plus permission matrix updates (audited).

import crypto from 'node:crypto';
import {
  MAX_CUSTOM_ROLE_RANK,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  SYSTEM_STAFF_ROLES,
} from '../../config/permissions.catalog.js';
import { AdminRole } from '../../models/AdminRole.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit.service.js';
import {
  assertCanAssignRole,
  ensureSystemRoles,
  getRankForRole,
  isCustomRoleSlug,
} from '../rbac.service.js';
import { assertStaffTwoFactor } from './staffSecurity.service.js';

function presentRole(role, staffCount = 0) {
  return {
    id: role._id,
    slug: role.slug,
    name: role.name,
    description: role.description ?? '',
    isSystem: Boolean(role.isSystem),
    isActive: role.isActive !== false,
    rank: role.rank,
    permissions: (role.permissions ?? []).map((entry) => ({
      module: entry.module,
      actions: [...(entry.actions ?? [])],
    })),
    staffCount,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

function normalizePermissions(permissions) {
  const byModule = new Map();
  for (const entry of permissions ?? []) {
    if (!PERMISSION_MODULES.includes(entry.module)) continue;
    const actions = [...new Set((entry.actions ?? []).filter((action) => PERMISSION_ACTIONS.includes(action)))];
    if (actions.length > 0) byModule.set(entry.module, actions);
  }
  return PERMISSION_MODULES.filter((module) => byModule.has(module)).map((module) => ({
    module,
    actions: byModule.get(module),
  }));
}

async function staffCountsByRole() {
  const rows = await User.aggregate([
    { $match: { role: { $ne: 'USER' } } },
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

// GET /admin/roles/catalog
export async function getPermissionCatalog() {
  await ensureSystemRoles();
  return {
    modules: PERMISSION_MODULES,
    actions: PERMISSION_ACTIONS,
    systemRoles: SYSTEM_STAFF_ROLES,
    maxCustomRank: MAX_CUSTOM_ROLE_RANK,
  };
}

// GET /admin/roles/stats
export async function getRoleStats() {
  await ensureSystemRoles();
  const [roles, staffTotal, customCount, inactiveStaff] = await Promise.all([
    AdminRole.countDocuments({ isActive: true }),
    User.countDocuments({ role: { $ne: 'USER' } }),
    AdminRole.countDocuments({ isSystem: false, isActive: true }),
    User.countDocuments({ role: { $ne: 'USER' }, status: { $in: ['SUSPENDED', 'BANNED'] } }),
  ]);
  return { roles, staffTotal, customRoles: customCount, inactiveStaff };
}

// GET /admin/roles
export async function listRoles() {
  await ensureSystemRoles();
  const [roles, counts] = await Promise.all([
    AdminRole.find().sort({ rank: -1, name: 1 }).lean(),
    staffCountsByRole(),
  ]);
  return {
    items: roles.map((role) => presentRole(role, counts.get(role.slug) ?? 0)),
  };
}

// GET /admin/roles/:roleId
export async function getRole(roleId) {
  await ensureSystemRoles();
  const role = await AdminRole.findById(roleId).lean();
  if (!role) throw ApiError.notFound();
  const staffCount = await User.countDocuments({ role: role.slug });
  return presentRole(role, staffCount);
}

// POST /admin/roles
export async function createRole(actor, input) {
  await assertStaffTwoFactor(actor, input.twoFactorCode);
  await ensureSystemRoles();
  const actorRank = await getRankForRole(actor.role);
  if (actorRank < 80) throw ApiError.forbidden();

  const rank = Math.min(input.rank ?? 20, MAX_CUSTOM_ROLE_RANK, actorRank - 1);
  if (rank < 1) throw ApiError.validation([{ field: 'rank', reason: 'OUT_OF_RANGE' }]);

  const slug = `CUSTOM_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const role = await AdminRole.create({
    slug,
    name: input.name,
    description: input.description ?? '',
    isSystem: false,
    isActive: true,
    rank,
    permissions: normalizePermissions(input.permissions),
  });

  await recordAudit(actor, {
    action: 'ROLE_CREATED',
    targetType: 'ROLE',
    targetId: role._id,
    metadata: { slug, name: role.name, rank },
  });

  return presentRole(role, 0);
}

// PATCH /admin/roles/:roleId
export async function updateRole(actor, roleId, input) {
  await assertStaffTwoFactor(actor, input.twoFactorCode);
  await ensureSystemRoles();
  const role = await AdminRole.findById(roleId);
  if (!role) throw ApiError.notFound();

  const actorRank = await getRankForRole(actor.role);
  if (actorRank < 80) throw ApiError.forbidden();
  if (role.isSystem && actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') throw ApiError.forbidden();
  if (role.slug === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only a Super Admin can edit the Super Admin role.');
  }

  const before = { name: role.name, description: role.description, rank: role.rank, isActive: role.isActive };

  if (input.name !== undefined) role.name = input.name;
  if (input.description !== undefined) role.description = input.description;
  if (input.isActive !== undefined) {
    if (role.isSystem && input.isActive === false) {
      throw ApiError.conflict('System roles cannot be deactivated.');
    }
    role.isActive = input.isActive;
  }
  if (input.rank !== undefined && !role.isSystem) {
    role.rank = Math.min(input.rank, MAX_CUSTOM_ROLE_RANK, actorRank - 1);
  }

  await role.save();
  await recordAudit(actor, {
    action: 'ROLE_UPDATED',
    targetType: 'ROLE',
    targetId: role._id,
    metadata: { before, after: { name: role.name, description: role.description, rank: role.rank, isActive: role.isActive } },
  });

  const staffCount = await User.countDocuments({ role: role.slug });
  return presentRole(role.toObject(), staffCount);
}

// PUT /admin/roles/:roleId/permissions — replace matrix (bulk assignment).
export async function updateRolePermissions(actor, roleId, { permissions, twoFactorCode }) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  await ensureSystemRoles();
  const role = await AdminRole.findById(roleId);
  if (!role) throw ApiError.notFound();

  const actorRank = await getRankForRole(actor.role);
  if (actorRank < 80) throw ApiError.forbidden();
  if (role.slug === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only a Super Admin can change Super Admin permissions.');
  }
  if (role.isSystem && role.slug === 'SUPER_ADMIN') {
    // Super Admin always keeps full access — ignore attempts to strip.
    throw ApiError.conflict('Super Admin permissions are fixed.');
  }

  const before = role.permissions;
  role.permissions = normalizePermissions(permissions);
  await role.save();

  await recordAudit(actor, {
    action: 'ROLE_PERMISSIONS_UPDATED',
    targetType: 'ROLE',
    targetId: role._id,
    metadata: { slug: role.slug, before, after: role.permissions },
  });

  const staffCount = await User.countDocuments({ role: role.slug });
  return presentRole(role.toObject(), staffCount);
}

// DELETE /admin/roles/:roleId
export async function deleteRole(actor, roleId, { twoFactorCode } = {}) {
  await assertStaffTwoFactor(actor, twoFactorCode);
  await ensureSystemRoles();
  const role = await AdminRole.findById(roleId);
  if (!role) throw ApiError.notFound();
  if (role.isSystem) throw ApiError.conflict('System roles cannot be deleted.');

  const actorRank = await getRankForRole(actor.role);
  if (actorRank < 80) throw ApiError.forbidden();
  if (role.rank >= actorRank) throw ApiError.forbidden();

  const assigned = await User.countDocuments({ role: role.slug });
  if (assigned > 0) throw ApiError.conflict('Reassign staff before deleting this role.');

  await AdminRole.deleteOne({ _id: roleId });
  await recordAudit(actor, {
    action: 'ROLE_DELETED',
    targetType: 'ROLE',
    targetId: roleId,
    metadata: { slug: role.slug, name: role.name },
  });

  return { deleted: true, id: roleId };
}

export async function assertAssignableStaffRole(actorRole, roleSlug) {
  await ensureSystemRoles();
  if (!isCustomRoleSlug(roleSlug) && !SYSTEM_STAFF_ROLES.includes(roleSlug)) {
    throw ApiError.validation([{ field: 'role', reason: 'UNKNOWN_OPTION' }]);
  }
  const role = await AdminRole.findOne({ slug: roleSlug, isActive: true }).lean();
  if (!role) throw ApiError.validation([{ field: 'role', reason: 'UNKNOWN_OPTION' }]);
  await assertCanAssignRole(actorRole, roleSlug);
  return role;
}
