// Fixed admin modules and default permission matrices for system staff roles.

export const PERMISSION_ACTIONS = ['VIEW', 'CREATE', 'EDIT', 'DELETE'];

export const PERMISSION_MODULES = [
  'DASHBOARD',
  'ANALYTICS',
  'USERS',
  'PROFILES',
  'REPORTS',
  'VERIFICATIONS',
  'MATCHES',
  'SWIPES',
  'MESSAGING',
  'BLOCKS',
  'SUPPORT',
  'NOTIFICATIONS',
  'SUBSCRIPTIONS',
  'PAYMENTS',
  'COUPONS',
  'REFERRALS',
  'CMS',
  'EXPERIMENTS',
  'FRAUD',
  'CALLS',
  'MONITORING',
  'SETTINGS',
  'AUDIT_LOGS',
  'STAFF',
  'ROLES',
];

export const SYSTEM_STAFF_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MODERATOR',
  'SUPPORT_AGENT',
  'FINANCE_MANAGER',
  'MARKETING_MANAGER',
  'ANALYST',
];

export const ROLE_RANKS = {
  SUPER_ADMIN: 100,
  ADMIN: 80,
  FINANCE_MANAGER: 50,
  MARKETING_MANAGER: 50,
  MODERATOR: 40,
  SUPPORT_AGENT: 35,
  ANALYST: 20,
};

const ALL = PERMISSION_ACTIONS;
const READ = ['VIEW'];
const READ_WRITE = ['VIEW', 'CREATE', 'EDIT'];
const MODERATE = ['VIEW', 'EDIT'];

function matrix(entries) {
  return Object.entries(entries).map(([module, actions]) => ({ module, actions: [...actions] }));
}

function allModules(actions) {
  return Object.fromEntries(PERMISSION_MODULES.map((module) => [module, actions]));
}

export const SYSTEM_ROLE_DEFINITIONS = [
  {
    slug: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Full platform control, including staff and role management.',
    rank: ROLE_RANKS.SUPER_ADMIN,
    permissions: matrix(allModules(ALL)),
  },
  {
    slug: 'ADMIN',
    name: 'Admin',
    description: 'Full operational access. Cannot manage Super Admins or delete system roles.',
    rank: ROLE_RANKS.ADMIN,
    permissions: matrix({
      ...allModules(ALL),
      ROLES: READ_WRITE,
      STAFF: READ_WRITE,
    }),
  },
  {
    slug: 'MODERATOR',
    name: 'Moderator',
    description: 'Safety, users, profiles, reports and verifications.',
    rank: ROLE_RANKS.MODERATOR,
    permissions: matrix({
      DASHBOARD: READ,
      ANALYTICS: READ,
      USERS: MODERATE,
      PROFILES: MODERATE,
      REPORTS: MODERATE,
      VERIFICATIONS: MODERATE,
      MATCHES: READ,
      MESSAGING: READ,
      BLOCKS: READ,
      SUPPORT: MODERATE,
      FRAUD: MODERATE,
      NOTIFICATIONS: READ,
      CMS: READ,
    }),
  },
  {
    slug: 'SUPPORT_AGENT',
    name: 'Support Agent',
    description: 'Support tickets and read-only member context.',
    rank: ROLE_RANKS.SUPPORT_AGENT,
    permissions: matrix({
      DASHBOARD: READ,
      USERS: READ,
      PROFILES: READ,
      SUPPORT: ALL,
      REPORTS: READ,
      VERIFICATIONS: READ,
    }),
  },
  {
    slug: 'FINANCE_MANAGER',
    name: 'Finance Manager',
    description: 'Subscriptions, payments, coupons and referrals.',
    rank: ROLE_RANKS.FINANCE_MANAGER,
    permissions: matrix({
      DASHBOARD: READ,
      ANALYTICS: READ,
      USERS: READ,
      SUBSCRIPTIONS: ALL,
      PAYMENTS: ALL,
      COUPONS: ALL,
      REFERRALS: ALL,
      AUDIT_LOGS: READ,
    }),
  },
  {
    slug: 'MARKETING_MANAGER',
    name: 'Marketing Manager',
    description: 'Campaigns, CMS, experiments and referrals.',
    rank: ROLE_RANKS.MARKETING_MANAGER,
    permissions: matrix({
      DASHBOARD: READ,
      ANALYTICS: READ,
      NOTIFICATIONS: ALL,
      CMS: ALL,
      EXPERIMENTS: ALL,
      REFERRALS: READ_WRITE,
      USERS: READ,
    }),
  },
  {
    slug: 'ANALYST',
    name: 'Analyst (Read Only)',
    description: 'Read-only analytics and operational metrics.',
    rank: ROLE_RANKS.ANALYST,
    permissions: matrix({
      DASHBOARD: READ,
      ANALYTICS: READ,
      USERS: READ,
      PROFILES: READ,
      MATCHES: READ,
      SWIPES: READ,
      MESSAGING: READ,
      MONITORING: READ,
    }),
  },
];

export const MAX_CUSTOM_ROLE_RANK = 30;
