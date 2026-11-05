// HTTP handlers for /profile, /profiles and /interests.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import { listOwnLoginHistory } from '../services/loginHistory.service.js';
import * as profileService from '../services/profile.service.js';
import { listInterests } from '../services/interest.service.js';
import {
  validateInterestIds,
  validateOnboarding,
  validatePreferences,
  validateProfileUpdate,
} from '../validators/profile.validator.js';

// GET /profile/me — the signed-in member's own profile.
export async function getMyProfile(req, res) {
  return ApiResponse.ok(res, await profileService.getMyProfile(req.user.id));
}

// GET /profile/login-activity — the signed-in member's own login history.
export async function getMyLoginActivity(req, res) {
  return ApiResponse.ok(res, await listOwnLoginHistory(req.user.id, parsePagination(req.query)));
}

// POST /profile/onboarding — creates the profile once after the first sign-in.
export async function completeOnboarding(req, res) {
  const input = validateOnboarding(req.body);
  return ApiResponse.ok(res, await profileService.completeOnboarding(req.user.id, input));
}

// PATCH /profile/me — partial profile edit.
export async function updateMyProfile(req, res) {
  const changes = validateProfileUpdate(req.body);
  return ApiResponse.ok(res, await profileService.updateMyProfile(req.user.id, changes));
}

// PUT /profile/preferences — replaces discovery preferences.
export async function updatePreferences(req, res) {
  const preferences = validatePreferences(req.body);
  return ApiResponse.ok(res, await profileService.updatePreferences(req.user.id, preferences));
}

// PUT /profile/interests — replaces interests.
export async function replaceInterests(req, res) {
  const { interestIds } = validateInterestIds(req.body);
  return ApiResponse.ok(res, await profileService.replaceInterests(req.user.id, interestIds));
}

// GET /profiles/:userId — another member's public profile.
export async function getPublicProfile(req, res) {
  return ApiResponse.ok(res, await profileService.getPublicProfile(req.user.id, req.params.userId));
}

// GET /interests — the interest catalogue.
export async function getInterests(req, res) {
  return ApiResponse.ok(res, { items: await listInterests() });
}
