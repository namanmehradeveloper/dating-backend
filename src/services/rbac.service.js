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
      // Full catalog only when missing/empty. Otherwise append newly added catalog modules
      // and missing catalog actions on existing modules (intentional removals of non-catalog
      // extras are kept; catalog defaults can grow).
      let permissionsUpdate;
      if (!existing || storedCount === 0) {
        permissionsUpdate = definition.permissions;
      } else {
        const catalogByModule = new Map(definition.permissions.map((entry) => [entry.module, entry.actions]));
        let changed = false;
        const next = existing.permissions.map((entry) => {
          const catalogActions = catalogByModule.get(entry.module);
          if (!catalogActions) return entry;
          const haveActions = new Set(entry.actions ?? []);
          const missingActions = catalogActions.filter((action) => !haveActions.has(action));
          if (missingActions.length === 0) return entry;
          changed = true;
          return { module: entry.module, actions: [...(entry.actions ?? []), ...missingActions] };
        });
        const haveModules = new Set(existing.permissions.map((entry) => entry.module));
        const missingModules = definition.permissions.filter((entry) => !haveModules.has(entry.module));
        if (missingModules.length > 0) {
          changed = true;
          permissionsUpdate = [...next, ...missingModules];
        } else if (changed) {
          permissionsUpdate = next;
        }
      }

      await AdminRole.updateOne(
        { slug: definition.slug },
        {
          $set: {
            name: definition.name,
            description: definition.description,
            isSystem: true,
            isActive: true,
            rank: definition.rank,
            ...(permissionsUpdate ? { permissions: permissionsUpdate } : {}),
          },
          $setOnInsert: {
            slug: definition.slug,
            ...(permissionsUpdate ? {} : { permissions: definition.permissions }),
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

// Active Super Admins: role SUPER_ADMIN, status ACTIVE, not already scheduled for deletion.
export async function countActiveSuperAdmins({ excludeUserId = null } = {}) {
  const filter = {
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    $or: [{ 'deletion.status': { $exists: false } }, { 'deletion.status': { $ne: 'SCHEDULED' } }],
  };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  return User.countDocuments(filter);
}

// Blocks demotion / suspension / deletion / schedule / force-purge when no other active
// Super Admin would remain. Pass `includeScheduledTarget: true` for irreversible erase of an
// account that is already on the deletion ledger (scheduled targets are otherwise skipped).
export async function assertNotLastActiveSuperAdmin(
  target,
  { actionLabel = 'modify', includeScheduledTarget = false } = {},
) {
  if (!target || target.role !== 'SUPER_ADMIN') return;
  if (!includeScheduledTarget) {
    if (target.status !== 'ACTIVE') return;
    if (target.deletion?.status === 'SCHEDULED') return;
  }
  const targetId = target._id ?? target.id;
  const others = await countActiveSuperAdmins({ excludeUserId: targetId });
  if (others < 1) {
    throw ApiError.conflict(`Cannot ${actionLabel} the last active Super Admin.`);
  }
}
