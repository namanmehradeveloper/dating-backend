// Validates onboarding, profile edits, preferences and interest changes.
// Reasons (LENGTH_1_40, COUNT_2_6, NOT_CURRENT, …) follow api_reference.md.

import { GENDERS, RELATIONSHIP_GOALS, SHOW_ME_OPTIONS } from '../models/Profile.js';
import {
  checkBoolean,
  checkEnum,
  checkInteger,
  checkIsoDate,
  checkText,
  checkUniqueStringList,
  isPlainObject,
  requireObjectBody,
  throwIfInvalid,
  trimmedText,
} from './common.js';

// The app owns the basics questions and prompts, so ids are checked for their documented format
// (ProfileBasics / ProfilePrompt in openapi.yaml) instead of a fixed list.
const BASICS_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const OPTION_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const MAX_BASICS = 20;

// Optional free text up to `max` characters; an empty value means "not set".
function checkOptionalText(details, field, value, max, reason) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length > max) {
    details.push({ field, reason });
    return undefined;
  }
  return value.trim() === '' ? undefined : value.trim();
}

// Optional lifestyle answers: { drinking: "SOBER", workout: "OFTEN" }.
function checkBasics(details, value) {
  if (value === undefined || value === null) return undefined;
  const entries = isPlainObject(value) ? Object.entries(value) : null;
  const isValid =
    entries &&
    entries.length <= MAX_BASICS &&
    entries.every(([key, option]) => BASICS_KEY_PATTERN.test(key) && typeof option === 'string' && OPTION_ID_PATTERN.test(option));

  if (!isValid) {
    details.push({ field: 'basics', reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Optional profile prompt: { promptId, answer (1–150 chars) }.
function checkPrompt(details, value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    details.push({ field: 'prompt', reason: 'INVALID' });
    return undefined;
  }
  if (typeof value.promptId !== 'string' || !OPTION_ID_PATTERN.test(value.promptId)) {
    details.push({ field: 'prompt.promptId', reason: 'UNKNOWN_OPTION' });
    return undefined;
  }
  const answer = trimmedText(value.answer);
  if (!answer || answer.length > 150) {
    details.push({ field: 'prompt.answer', reason: 'INVALID' });
    return undefined;
  }
  return { promptId: value.promptId, answer };
}

// Optional approximate location, rounded to 2 decimals (~1 km). Stored as a GeoJSON point.
function checkLocation(details, value) {
  if (value === undefined || value === null) return undefined;
  const { latitude, longitude } = isPlainObject(value) ? value : {};
  const isValid =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  if (!isValid) {
    details.push({ field: 'location', reason: 'INVALID' });
    return undefined;
  }
  const round = (number) => Math.round(number * 100) / 100;
  return { type: 'Point', coordinates: [round(longitude), round(latitude)] };
}

// POST /profile/onboarding.
export function validateOnboarding(body) {
  requireObjectBody(body);
  const details = [];

  const input = {
    displayName: checkText(details, 'displayName', body.displayName, { max: 40, reason: 'LENGTH_1_40' }),
    dateOfBirth: checkIsoDate(details, 'dateOfBirth', body.dateOfBirth),
    gender: checkEnum(details, 'gender', body.gender, GENDERS),
    showGender: checkBoolean(details, 'showGender', body.showGender, { required: false }) ?? false,
    showMe: checkEnum(details, 'showMe', body.showMe, SHOW_ME_OPTIONS),
    maxDistanceKm: checkInteger(details, 'maxDistanceKm', body.maxDistanceKm, { min: 1, max: 500, reason: 'RANGE_1_500' }),
    relationshipGoal: checkEnum(details, 'relationshipGoal', body.relationshipGoal, RELATIONSHIP_GOALS),
    interestIds: checkUniqueStringList(details, 'interestIds', body.interestIds, { min: 1, max: 10, reason: 'COUNT_1_10' }),
    photoMediaIds: checkUniqueStringList(details, 'photoMediaIds', body.photoMediaIds, { min: 2, max: 6, reason: 'COUNT_2_6' }),
    basics: checkBasics(details, body.basics),
    bio: checkOptionalText(details, 'bio', body.bio, 500, 'MAX_500'),
    prompt: checkPrompt(details, body.prompt),
    location: checkLocation(details, body.location),
    acceptedTermsVersion: checkText(details, 'acceptedTermsVersion', body.acceptedTermsVersion, { max: 20, reason: 'NOT_CURRENT' }),
  };

  throwIfInvalid(details);
  return input;
}

// Optional text that may be cleared with "" or null (bio, city, occupation).
// Returns undefined (not sent), { clear: true } or { value }.
function checkClearableText(details, field, value, max, reason) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return { clear: true };
  if (typeof value !== 'string' || value.trim().length > max) {
    details.push({ field, reason });
    return undefined;
  }
  return { value: value.trim() };
}

const EDITABLE_PROFILE_FIELDS = ['displayName', 'bio', 'interests', 'city', 'occupation'];

// PATCH /profile/me: at least one of displayName, bio, interests, city, occupation.
export function validateProfileUpdate(body) {
  requireObjectBody(body);
  const hasAnyField = EDITABLE_PROFILE_FIELDS.some((field) => body[field] !== undefined);
  if (!hasAnyField) throwIfInvalid([{ field: 'body', reason: 'NO_FIELDS' }]);

  const details = [];
  const update = {
    bio: checkClearableText(details, 'bio', body.bio, 500, 'MAX_500'),
    city: checkClearableText(details, 'city', body.city, 80, 'INVALID_LENGTH'),
    occupation: checkClearableText(details, 'occupation', body.occupation, 80, 'INVALID_LENGTH'),
  };
  if (body.displayName !== undefined) {
    update.displayName = checkText(details, 'displayName', body.displayName, { max: 40, reason: 'LENGTH_1_40' });
  }
  if (body.interests !== undefined) {
    update.interests = checkUniqueStringList(details, 'interests', body.interests, { min: 1, max: 10, reason: 'COUNT_1_10' });
  }

  throwIfInvalid(details);
  return update;
}

// PUT /profile/preferences: { minAge, maxAge, maxDistanceKm, showMe } with minAge ≤ maxAge.
export function validatePreferences(body) {
  requireObjectBody(body);
  const details = [];
  const minAge = checkInteger(details, 'minAge', body.minAge, { min: 18, max: 99 });
  const maxAge = checkInteger(details, 'maxAge', body.maxAge, { min: 18, max: 99 });
  const maxDistanceKm = checkInteger(details, 'maxDistanceKm', body.maxDistanceKm, { min: 1, max: 500, reason: 'RANGE_1_500' });
  const showMe = checkEnum(details, 'showMe', body.showMe, SHOW_ME_OPTIONS);

  if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
    details.push({ field: 'minAge', reason: 'OUT_OF_RANGE' });
  }
  throwIfInvalid(details);
  return { minAge, maxAge, maxDistanceKm, showMe };
}

// PUT /profile/interests: { interestIds } with 1–10 unique ids.
export function validateInterestIds(body) {
  requireObjectBody(body);
  const details = [];
  const interestIds = checkUniqueStringList(details, 'interestIds', body.interestIds, { min: 1, max: 10, reason: 'COUNT_1_10' });
  throwIfInvalid(details);
  return { interestIds };
}
