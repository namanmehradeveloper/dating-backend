// Small helpers shared by the request validators. Each validator collects every problem as
// { field, reason } and throws one VALIDATION_ERROR, so the app can highlight all fields at once.

import { validate as isUuid } from 'uuid';
import { ApiError } from '../utils/ApiError.js';

export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Throws VALIDATION_ERROR when any problem was collected.
export function throwIfInvalid(details) {
  if (details.length > 0) throw ApiError.validation(details);
}

// Returns true for a plain JSON object (not null, not an array).
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Makes sure the body is a JSON object so validators can read its fields safely.
export function requireObjectBody(body) {
  if (!isPlainObject(body)) throw ApiError.validation([{ field: 'body', reason: 'INVALID' }]);
  return body;
}

// Returns true when the value was not sent at all.
export function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Returns the trimmed string, or undefined when the value is not a string.
export function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

// Checks a required text field with a length range; records REQUIRED or the given length reason.
export function checkText(details, field, value, { min = 1, max, reason, required = true }) {
  if (isMissing(value)) {
    if (required) details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  const text = trimmedText(value);
  if (text === undefined || text.length < min || (max && text.length > max)) {
    details.push({ field, reason: reason ?? 'INVALID_LENGTH' });
    return undefined;
  }
  return text;
}

// Checks that a value is one of the allowed options; records REQUIRED or UNKNOWN_OPTION.
export function checkEnum(details, field, value, options, { required = true, reason = 'UNKNOWN_OPTION' } = {}) {
  if (isMissing(value)) {
    if (required) details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (!options.includes(value)) {
    details.push({ field, reason });
    return undefined;
  }
  return value;
}

// Checks a whole number in a range; records REQUIRED or the given range reason.
export function checkInteger(details, field, value, { min, max, reason = 'OUT_OF_RANGE', required = true }) {
  if (value === undefined || value === null) {
    if (required) details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    details.push({ field, reason });
    return undefined;
  }
  return value;
}

// Checks a true/false field.
export function checkBoolean(details, field, value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (typeof value !== 'boolean') {
    details.push({ field, reason: 'INVALID' });
    return undefined;
  }
  return value;
}

// Checks an E.164 phone number such as +919876543210.
export function checkPhoneNumber(details, value, field = 'phoneNumber') {
  if (isMissing(value)) {
    details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (typeof value !== 'string' || !E164_PATTERN.test(value)) {
    details.push({ field, reason: 'INVALID_FORMAT' });
    return undefined;
  }
  return value;
}

// Checks an email address and returns it lower-cased.
export function checkEmail(details, value, field = 'email') {
  if (isMissing(value)) {
    details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  const email = trimmedText(value)?.toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    details.push({ field, reason: 'INVALID_FORMAT' });
    return undefined;
  }
  return email;
}

// Checks a calendar date written as YYYY-MM-DD and returns it as a UTC Date.
export function checkIsoDate(details, field, value, { reason = 'INVALID' } = {}) {
  if (isMissing(value)) {
    details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    details.push({ field, reason });
    return undefined;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || date > new Date()) {
    details.push({ field, reason });
    return undefined;
  }
  return date;
}

// Checks an ISO-8601 timestamp (used for optional "until" dates) and returns a Date.
export function checkTimestamp(details, field, value, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    details.push({ field, reason: 'INVALID_FORMAT' });
    return undefined;
  }
  return date;
}

// Checks a list of unique strings with a size range; records the given count reason.
export function checkUniqueStringList(details, field, value, { min, max, reason }) {
  if (value === undefined || value === null) {
    details.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  const isValidList =
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim() !== '') &&
    new Set(value).size === value.length &&
    value.length >= min &&
    value.length <= max;

  if (!isValidList) {
    details.push({ field, reason });
    return undefined;
  }
  return value;
}

// Reads and checks the Idempotency-Key header (a UUID). Throws VALIDATION_ERROR when missing or malformed.
export function readIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key) throw ApiError.validation([{ field: 'Idempotency-Key', reason: 'REQUIRED' }]);
  if (!isUuid(key)) throw ApiError.validation([{ field: 'Idempotency-Key', reason: 'INVALID_FORMAT' }]);
  return key;
}

// Checks an id path parameter (for example usr_… or mat_…) so malformed ids become 404 later.
export function isValidId(value) {
  return typeof value === 'string' && /^[a-z]{3}_[0-9a-f]{24}$/.test(value);
}
