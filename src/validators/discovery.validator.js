// Validates discovery filters and swipe requests.

import { SWIPE_ACTIONS } from '../models/Swipe.js';
import { checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';

// Reads an optional whole-number query parameter within a range.
function readIntegerQuery(details, query, field, min, max) {
  const raw = query[field];
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    details.push({ field, reason: 'INVALID_FORMAT' });
    return undefined;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    details.push({ field, reason: 'OUT_OF_RANGE' });
    return undefined;
  }
  return value;
}

// GET /discovery filters: minAge and maxAge (18–99, minAge ≤ maxAge) and distanceKm (1–500).
export function validateDiscoveryFilters(query) {
  const details = [];
  const minAge = readIntegerQuery(details, query, 'minAge', 18, 99);
  const maxAge = readIntegerQuery(details, query, 'maxAge', 18, 99);
  const distanceKm = readIntegerQuery(details, query, 'distanceKm', 1, 500);

  if (minAge !== undefined && maxAge !== undefined && maxAge < minAge) {
    details.push({ field: 'maxAge', reason: 'OUT_OF_RANGE' });
  }
  throwIfInvalid(details);
  return { minAge, maxAge, distanceKm };
}

// POST /swipes: { targetUserId, action: LIKE | PASS | SUPER_LIKE }.
export function validateSwipe(body) {
  requireObjectBody(body);
  const details = [];
  const targetUserId = checkText(details, 'targetUserId', body.targetUserId, { max: 64, reason: 'INVALID' });
  const action = checkEnum(details, 'action', body.action, SWIPE_ACTIONS, { reason: 'INVALID' });
  throwIfInvalid(details);
  return { targetUserId, action };
}
