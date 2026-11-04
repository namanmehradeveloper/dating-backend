// Cursor pagination (?cursor=&limit=) shared by every list endpoint.
// Lists are ordered by a date field (createdAt by default) with _id breaking ties.
// The cursor is an opaque base64url string holding the date and _id of the last item on a page.
//
// Typical use in a service:
//   const { limit, cursor } = parsePagination(req.query);
//   const docs = await Model.find({ ...filter, ...getAfterCursorFilter(cursor) })
//     .sort(getPageSort()).limit(limit + 1);
//   return buildPage(docs, limit);

import { ApiError } from './ApiError.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_ID_LENGTH = 128;

// Turns the last item's date and id into the cursor string sent to the client as nextCursor.
export function encodeCursor(date, id) {
  const value = date instanceof Date ? date : new Date(date);
  const payload = { date: value.toISOString(), id: String(id) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// Combines query fragments without letting a later `$or` overwrite an earlier one (e.g. expired
// bucket + cursor, or report search + cursor). Empty fragments are skipped.
export function mergeFilters(...parts) {
  const filters = parts.filter((part) => part && typeof part === 'object' && Object.keys(part).length > 0);
  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { $and: filters };
}

// Reads a cursor string back into { date, id }. Returns null when the cursor is malformed.
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.id !== 'string' || typeof payload.date !== 'string') return null;
  if (payload.id === '' || payload.id.length > MAX_ID_LENGTH) return null;

  const date = new Date(payload.date);
  if (Number.isNaN(date.getTime())) return null;

  return { date, id: payload.id };
}

// Checks ?limit= and returns its number, or a validation detail when it is not a whole number in 1..maxLimit.
function readLimit(rawLimit, defaultLimit, maxLimit) {
  if (rawLimit === undefined || rawLimit === '') return { limit: defaultLimit };

  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
    return { problem: { field: 'limit', reason: 'INVALID_FORMAT' } };
  }

  const limit = Number(rawLimit);
  if (limit < 1 || limit > maxLimit) {
    return { problem: { field: 'limit', reason: 'OUT_OF_RANGE' } };
  }
  return { limit };
}

// Reads ?cursor=&limit= from the query string. An empty cursor means the first page.
// Returns { limit, cursor } or throws VALIDATION_ERROR listing every invalid parameter.
export function parsePagination(query = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const problems = [];

  const limitResult = readLimit(query.limit, defaultLimit, maxLimit);
  if (limitResult.problem) problems.push(limitResult.problem);

  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    cursor = decodeCursor(query.cursor);
    if (!cursor) problems.push({ field: 'cursor', reason: 'INVALID_FORMAT' });
  }

  if (problems.length > 0) throw ApiError.validation(problems);
  return { limit: limitResult.limit, cursor };
}

// Returns the Mongo sort for a page: by the date field, then by _id so equal dates keep a stable order.
export function getPageSort(dateField = 'createdAt', direction = 'desc') {
  const order = direction === 'asc' ? 1 : -1;
  return { [dateField]: order, _id: order };
}

// Returns the Mongo filter that selects only the items after the cursor (an empty filter on the first page).
export function getAfterCursorFilter(cursor, dateField = 'createdAt', direction = 'desc') {
  if (!cursor) return {};

  const operator = direction === 'asc' ? '$gt' : '$lt';
  return {
    $or: [
      { [dateField]: { [operator]: cursor.date } },
      { [dateField]: cursor.date, _id: { [operator]: cursor.id } },
    ],
  };
}

// Turns `limit + 1` fetched documents into { items, nextCursor }.
// The extra document only tells us another page exists; it is not returned.
export function buildPage(docs, limit, dateField = 'createdAt') {
  if (docs.length <= limit) return { items: docs, nextCursor: null };

  const items = docs.slice(0, limit);
  const lastItem = items[items.length - 1];
  return { items, nextCursor: encodeCursor(lastItem[dateField], lastItem._id) };
}
