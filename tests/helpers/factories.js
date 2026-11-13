// Test data builders: members with profiles, staff accounts and ready-made auth headers.
// They write straight to MongoDB so tests do not have to go through OTP sign-in each time.

import { afterAll, afterEach, beforeAll } from 'vitest';
import { Profile } from '../../src/models/Profile.js';
import { User } from '../../src/models/User.js';
import { SubscriptionEntitlement } from '../../src/models/SubscriptionEntitlement.js';
import { issueAccessToken } from '../../src/services/token.service.js';
import { resetRateLimits } from '../../src/utils/rateLimit.js';
import { clearTestDb, closeTestDb, connectTestDb } from './db.js';

let phoneCounter = 0;

// Registers the usual lifecycle for a test file: connect once, wipe data and rate limits after each test.
export function useTestDatabase() {
  beforeAll(connectTestDb);
  afterEach(async () => {
    await clearTestDb();
    await resetRateLimits();
  });
  afterAll(closeTestDb);
}

// Returns a unique valid E.164 phone number.
export function nextPhoneNumber() {
  phoneCounter += 1;
  return `+9198${String(Date.now()).slice(-4)}${String(phoneCounter).padStart(4, '0')}`;
}

// Returns a date of birth for someone who turned `age` about a month ago.
export function birthDateForAge(age) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(date.getUTCFullYear() - age);
  date.setUTCDate(date.getUTCDate() - 30);
  return date;
}

// Creates an onboarded member with a profile. `profile` and `user` override the defaults.
export async function createMember({ user = {}, profile = {} } = {}) {
  const account = await User.create({ phoneNumber: nextPhoneNumber(), onboardingComplete: true, ...user });
  const memberProfile = await Profile.create({
    userId: account._id,
    displayName: profile.displayName ?? 'Member',
    dateOfBirth: profile.dateOfBirth ?? birthDateForAge(profile.age ?? 28),
    gender: 'WOMAN',
    showGender: true,
    relationshipGoal: 'LONG_TERM',
    interestIds: [],
    photos: [],
    acceptedTermsVersion: '2026-01',
    ...profile,
    preferences: { minAge: 18, maxAge: 99, maxDistanceKm: 500, showMe: 'EVERYONE', ...(profile.preferences ?? {}) },
  });
  return { user: account, profile: memberProfile, token: issueAccessToken(account), id: account._id };
}

// Creates a staff (or member) account that signs in with email, without a dating profile.
export async function createStaff(role = 'ADMIN', overrides = {}) {
  const account = await User.create({ email: `${role.toLowerCase()}_${Date.now()}_${phoneCounter++}@example.test`, role, ...overrides });
  return { user: account, token: issueAccessToken(account), id: account._id };
}

// Gives a member an active PLUS entitlement directly in the database (as verification would).
export async function grantPremium(userId) {
  await SubscriptionEntitlement.create({
    userId,
    tier: 'PLUS',
    isActive: true,
    productId: 'dc_plus_monthly',
    platform: 'ANDROID',
    provider: 'demo',
    environment: 'demo',
    expiresAt: new Date(Date.now() + 30 * 86400000),
    willRenew: true,
    originalTransactionId: `txn_${userId}`,
  });
}

// Builds the Authorization header for a token.
export function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}
