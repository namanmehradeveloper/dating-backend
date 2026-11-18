// Role seeding, permission resolution, rank checks and staff role detection.

import {
  MAX_CUSTOM_ROLE_RANK,
  ROLE_RANKS,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_STAFF_ROLES,
} from '../config/permissions.catalog.js';
import { AdminRole } from '../models/AdminRole.js';
import { ADMIN_TIER_ROLES, User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

export function isSystemStaffRole(role) {
  return SYSTEM_STAFF_ROLES.includes(role);
}

export function isCustomRoleSlug(role) {
  return typeof role === 'string' && role.startsWith('CUSTOM_');
}

export function isAdminTier(role) {
  return ADMIN_TIER_ROLES.includes(role);
}

let ensureSystemRolesInflight = null;

// Idempotent seed. Re-checks the DB so test wipes (and fresh deploys) still get system roles.
// Super Admin permissions are always forced to the full catalog matrix.
// Other system roles: catalog defaults only on insert (or empty matrix). Intentional edits are kept.
// Concurrent callers share one in-flight seed to avoid VersionError races.
export async function ensureSystemRoles() {
  if (ensureSystemRolesInflight) return ensureSystemRolesInflight;

  ensureSystemRolesInflight = (async () => {
    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      if (definition.slug === 'SUPER_ADMIN') {
        await AdminRole.updateOne(
          { slug: definition.slug },
          {
            $set: {
              name: definition.name,
              description: definition.description,
              isSystem: true,
              isActive: true,
              rank: definition.rank,
              permissions: definition.permissions,
            },
            $setOnInsert: { slug: definition.slug },
          },
          { upsert: true },
        );
        continue;
      }

      const existing = await AdminRole.findOne({ slug: definition.slug }).lean();
      const storedCount = existing?.permissions?.length ?? 0;
      // Only seed/repair when the role is missing or has an empty matrix — never overwrite
      // intentional permission edits (including reduced system-role matrices).
      const needsPermissionSeed = !existing || storedCount === 0;

      await AdminRole.updateOne(
        { slug: definition.slug },
        {
          $set: {
            name: definition.name,
            description: definition.description,
            isSystem: true,
            isActive: true,
            rank: definition.rank,
            ...(needsPermissionSeed ? { permissions: definition.permissions } : {}),
          },
          $setOnInsert: {
            slug: definition.slug,
            ...(needsPermissionSeed ? {} : { permissions: definition.permissions }),
          },
        },
        { upsert: true },
      );
    }
  })().finally(() => {
    ensureSystemRolesInflight = null;
  });

  return ensureSystemRolesInflight;
}

export async function isStaffRole(role) {
  if (!role || role === 'USER') return false;
  if (isSystemStaffRole(role)) return true;
  if (!isCustomRoleSlug(role)) return false;
  await ensureSystemRoles();
  return Boolean(await AdminRole.exists({ slug: role, isActive: true }));
}

export async function getRoleDocument(slug) {
  await ensureSystemRoles();
  return AdminRole.findOne({ slug }).lean();
}

export async function getRankForRole(role) {
  if (ROLE_RANKS[role] !== undefined) return ROLE_RANKS[role];
  const doc = await getRoleDocument(role);
  return doc?.rank ?? 0;
}

export async function getPermissionsForRole(role) {
  const doc = await getRoleDocument(role);
  if (!doc || !doc.isActive) return [];
  return (doc.permissions ?? []).map((entry) => ({
    module: entry.module,
    actions: [...(entry.actions ?? [])],
  }));
}

export function flattenPermissions(permissions) {
  const keys = new Set();
  for (const entry of permissions ?? []) {
    for (const action of entry.actions ?? []) {
      keys.add(`${entry.module}.${action}`);
    }
  }
  return [...keys];
}

export function hasPermission(permissions, module, action) {
  const entry = (permissions ?? []).find((item) => item.module === module);
  return Boolean(entry?.actions?.includes(action));
}

export async function assertCanManageTargetRole(actorRole, targetRole) {
  const [actorRank, targetRank] = await Promise.all([getRankForRole(actorRole), getRankForRole(targetRole)]);
  if (actorRank <= 0) throw ApiError.forbidden();
  if (targetRole === 'SUPER_ADMIN' && actorRole !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Only a Super Admin can manage Super Admin accounts.');
  }
  if (actorRole === 'SUPER_ADMIN') return { actorRank, targetRank };
  if (targetRank > actorRank) {
    throw ApiError.forbidden('You cannot manage an account with higher privilege.');
  }
  return { actorRank, targetRank };
}

export async function assertCanAssignRole(actorRole, newRole) {
  const [actorRank, newRank] = await Promise.all([getRankForRole(actorRole), getRankForRole(newRole)]);
  if (!(await isStaffRole(newRole))) throw ApiError.validation([{ field: 'role', reason: 'UNKNOWN_OPTION' }]);
  if (newRole === 'SUPER_ADMIN') {
    throw ApiError.forbidden('Super Admin accounts cannot be assigned through this panel.');
  }
  if (actorRole === 'SUPER_ADMIN') return { actorRank, newRank };
  if (newRank > actorRank) {
    throw ApiError.forbidden('You cannot assign a role with higher privilege.');
  }
  if (isCustomRoleSlug(newRole) && newRank > MAX_CUSTOM_ROLE_RANK) {
    throw ApiError.forbidden('Custom role rank is too high.');
  }
  return { actorRank, newRank };
}

export function staffRoleFilter() {
  return {
    $or: [{ role: { $in: SYSTEM_STAFF_ROLES } }, { role: { $regex: /^CUSTOM_/ } }],
  };
}

export async function countAdminTier() {
  return User.countDocuments({ role: { $in: ADMIN_TIER_ROLES } });
}
