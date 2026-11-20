// Cursor and offset pagination shared by list endpoints.
//
// Cursor mode (?cursor=&limit=): opaque base64url cursor of { date, id }. Used by member APIs
// and by admin "Load more" drawers when page is omitted.
//
// Offset mode (?page=&limit=): 1-based page + skip. Used by the admin panel table pager so
// numbered pages, totals, and page-size changes work without loading the full collection.
//
// Typical service use:
//   const pagination = parsePagination(req.query, { maxLimit: ADMIN_MAX_LIMIT });
//   const { docs, ...meta } = await queryPage(Model, filter, pagination, { dateField });
//   return { items: docs.map(present), ...pickPageMeta(meta) };

import { ApiError } from './ApiError.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Admin panel page-size options include 100. */
export const ADMIN_MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const MAX_ID_LENGTH = 128;
const MAX_PAGE = 1_000_000;

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

function readPage(rawPage) {
  if (rawPage === undefined || rawPage === '') return { page: null };
  if (typeof rawPage !== 'string' || !/^\d+$/.test(rawPage)) {
    return { problem: { field: 'page', reason: 'INVALID_FORMAT' } };
  }
  const page = Number(rawPage);
  if (page < 1 || page > MAX_PAGE) {
    return { problem: { field: 'page', reason: 'OUT_OF_RANGE' } };
  }
  return { page };
}

/**
 * Reads ?cursor=&limit=&page= from the query string.
 * - With `page`: offset mode (cursor ignored). Returns { mode:'offset', limit, page, skip, cursor:null }.
 * - Without `page`: cursor mode. Returns { mode:'cursor', limit, cursor, page:1, skip:0 }.
 */
export function parsePagination(query = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const problems = [];

  const limitResult = readLimit(query.limit, defaultLimit, maxLimit);
  if (limitResult.problem) problems.push(limitResult.problem);

  const pageResult = readPage(query.page);
  if (pageResult.problem) problems.push(pageResult.problem);

  let cursor = null;
  const useOffset = pageResult.page != null;

  if (!useOffset && query.cursor !== undefined && query.cursor !== '') {
    cursor = decodeCursor(query.cursor);
    if (!cursor) problems.push({ field: 'cursor', reason: 'INVALID_FORMAT' });
  }

  if (problems.length > 0) throw ApiError.validation(problems);

  const limit = limitResult.limit;
  if (useOffset) {
    const page = pageResult.page;
    return { mode: 'offset', limit, page, skip: (page - 1) * limit, cursor: null };
  }

  return { mode: 'cursor', limit, cursor, page: 1, skip: 0 };
}

/** Builds total/pageSize/totalPages/hasMore/hasPrev for an offset (or counted) response. */
export function paginationMeta({ page, limit, total }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / limit) || 1);
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  return {
    page: safePage,
    pageSize: limit,
    total: safeTotal,
    totalPages,
    hasMore: safePage < totalPages,
    hasPrev: safePage > 1,
  };
}

/** Picks the public page fields from a queryPage / finishOffsetPage result. */
export function pickPageMeta({ page, pageSize, total, totalPages, hasMore, hasPrev, nextCursor }) {
  return { page, pageSize, total, totalPages, hasMore, hasPrev, nextCursor: nextCursor ?? null };
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

/** Offset-page result from already-fetched docs + total count. */
export function finishOffsetPage(docs, pagination, total) {
  return {
    docs,
    nextCursor: null,
    ...paginationMeta({ page: pagination.page, limit: pagination.limit, total }),
  };
}

/**
 * Runs a cursor or offset page query against a Mongoose model.
 * `baseFilter` must NOT include cursor conditions (they are applied here when needed).
 */
export async function queryPage(Model, baseFilter, pagination, { dateField = 'createdAt', direction = 'desc', sort } = {}) {
  const sortSpec = sort || getPageSort(dateField, direction);
  const { limit, cursor, skip, mode, page } = pagination;

  if (mode === 'offset') {
    const [docs, total] = await Promise.all([
      Model.find(baseFilter).sort(sortSpec).skip(skip).limit(limit).lean(),
      Model.countDocuments(baseFilter),
    ]);
    return finishOffsetPage(docs, pagination, total);
  }

  const filter = mergeFilters(baseFilter, getAfterCursorFilter(cursor, dateField, direction));
  const [docs, total] = await Promise.all([
    Model.find(filter).sort(sortSpec).limit(limit + 1).lean(),
    Model.countDocuments(baseFilter),
  ]);
  const built = buildPage(docs, limit, dateField);
  return {
    docs: built.items,
    nextCursor: built.nextCursor,
    total,
    page: 1,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit) || 1),
    hasMore: Boolean(built.nextCursor),
    hasPrev: Boolean(cursor),
  };
}
