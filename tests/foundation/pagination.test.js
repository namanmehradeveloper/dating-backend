// Tests ?cursor=&limit= validation, cursor encoding, and walking real MongoDB pages without gaps or duplicates.

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/utils/ApiError.js';
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  getAfterCursorFilter,
  getPageSort,
  mergeFilters,
  parsePagination,
} from '../../src/utils/pagination.js';
import { closeTestDb, connectTestDb } from '../helpers/db.js';

// Runs fn, expects a 400 VALIDATION_ERROR, and returns its details for further checks.
function validationDetails(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    return err.details;
  }
  throw new Error('Expected a VALIDATION_ERROR');
}

// Encodes any JSON value as a base64url string, used to build malformed cursors.
function toBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('parsePagination', () => {
  it('defaults to limit 20 and no cursor', () => {
    expect(parsePagination({})).toEqual({ limit: 20, cursor: null });
    expect(parsePagination()).toEqual({ limit: 20, cursor: null });
  });

  it('treats empty values as absent (?cursor=&limit=)', () => {
    expect(parsePagination({ cursor: '', limit: '' })).toEqual({ limit: 20, cursor: null });
  });

  it.each([
    ['1', 1],
    ['10', 10],
    ['50', 50],
  ])('accepts limit=%s', (raw, expected) => {
    expect(parsePagination({ limit: raw }).limit).toBe(expected);
  });

  it('supports a per-endpoint default (messages default to 50)', () => {
    expect(parsePagination({}, { defaultLimit: 50 }).limit).toBe(50);
  });

  it.each(['0', '51', '1000'])('rejects out-of-range limit=%s', (raw) => {
    expect(validationDetails(() => parsePagination({ limit: raw }))).toEqual([{ field: 'limit', reason: 'OUT_OF_RANGE' }]);
  });

  it.each(['abc', '1.5', '-1', ' 5', ['10', '20']])('rejects malformed limit=%j', (raw) => {
    expect(validationDetails(() => parsePagination({ limit: raw }))).toEqual([{ field: 'limit', reason: 'INVALID_FORMAT' }]);
  });

  it.each([
    ['non-base64', 'not a cursor!'],
    ['not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON array', toBase64Url([1, 2])],
    ['missing id', toBase64Url({ date: '2026-01-01T00:00:00.000Z' })],
    ['missing date', toBase64Url({ id: 'a' })],
    ['bad date', toBase64Url({ date: 'yesterday', id: 'a' })],
    ['empty id', toBase64Url({ date: '2026-01-01T00:00:00.000Z', id: '' })],
    ['too long', 'a'.repeat(600)],
  ])('rejects a malformed cursor (%s)', (_label, cursor) => {
    expect(validationDetails(() => parsePagination({ cursor }))).toEqual([{ field: 'cursor', reason: 'INVALID_FORMAT' }]);
  });

  it('reports limit and cursor problems together', () => {
    expect(validationDetails(() => parsePagination({ limit: '0', cursor: '!!' }))).toEqual([
      { field: 'limit', reason: 'OUT_OF_RANGE' },
      { field: 'cursor', reason: 'INVALID_FORMAT' },
    ]);
  });
});

describe('cursor encoding', () => {
  it('round-trips the date and id of the last item', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const cursor = encodeCursor(date, 'usr_001');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ date, id: 'usr_001' });
  });
});

describe('sort and filter helpers', () => {
  it('sorts by the date field with _id as the tie-breaker', () => {
    expect(getPageSort()).toEqual({ createdAt: -1, _id: -1 });
    expect(getPageSort('sentAt', 'asc')).toEqual({ sentAt: 1, _id: 1 });
  });

  it('builds no filter for the first page', () => {
    expect(getAfterCursorFilter(null)).toEqual({});
  });

  it('merges query fragments without letting a later $or overwrite an earlier one', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const bucket = {
      $or: [
        { status: 'ENDED', endedReason: 'EXPIRED' },
        { status: 'ACTIVE', expiresAt: { $lte: date } },
      ],
    };
    expect(mergeFilters(bucket, getAfterCursorFilter({ date, id: 'x' }, 'matchedAt'))).toEqual({
      $and: [bucket, getAfterCursorFilter({ date, id: 'x' }, 'matchedAt')],
    });
    expect(mergeFilters({ status: 'ACTIVE' }, {})).toEqual({ status: 'ACTIVE' });
  });

  it('builds an after-cursor filter', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(getAfterCursorFilter({ date, id: 'x' })).toEqual({
      $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: 'x' } }],
    });
    expect(getAfterCursorFilter({ date, id: 'x' }, 'sentAt', 'asc')).toEqual({
      $or: [{ sentAt: { $gt: date } }, { sentAt: date, _id: { $gt: 'x' } }],
    });
  });

  it('returns nextCursor null on the last page', () => {
    expect(buildPage([{ _id: 'a' }], 20)).toEqual({ items: [{ _id: 'a' }], nextCursor: null });
  });
});

describe('cursor pagination against MongoDB', () => {
  const Probe = mongoose.model(
    'PaginationProbe',
    new mongoose.Schema({ _id: String, createdAt: Date }, { versionKey: false }),
  );
  const TOTAL = 45;

  beforeAll(async () => {
    await connectTestDb();
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    // Groups of three share a timestamp so the _id tie-breaker is exercised.
    await Probe.insertMany(
      Array.from({ length: TOTAL }, (_, i) => ({
        _id: `doc_${String(i).padStart(3, '0')}`,
        createdAt: new Date(start + Math.floor(i / 3) * 1000),
      })),
    );
  });
  afterAll(closeTestDb);

  // Follows nextCursor until the last page and returns the ids on each page.
  async function readAllPages(direction, pageSize) {
    const pages = [];
    let rawCursor = '';
    do {
      const { limit, cursor } = parsePagination({ limit: String(pageSize), cursor: rawCursor });
      const docs = await Probe.find(getAfterCursorFilter(cursor, 'createdAt', direction))
        .sort(getPageSort('createdAt', direction))
        .limit(limit + 1)
        .lean();
      const page = buildPage(docs, limit);
      pages.push(page.items.map((doc) => doc._id));
      rawCursor = page.nextCursor;
    } while (rawCursor);
    return pages;
  }

  it('walks newest-first pages without gaps or duplicates', async () => {
    const pages = await readAllPages('desc', 20);
    expect(pages.map((page) => page.length)).toEqual([20, 20, 5]);

    const ids = pages.flat();
    expect(new Set(ids).size).toBe(TOTAL);
    const expected = Array.from({ length: TOTAL }, (_, i) => `doc_${String(TOTAL - 1 - i).padStart(3, '0')}`);
    expect(ids).toEqual(expected);
  });

  it('walks oldest-first pages across timestamp ties', async () => {
    const pages = await readAllPages('asc', 7);
    const ids = pages.flat();
    expect(ids).toEqual(Array.from({ length: TOTAL }, (_, i) => `doc_${String(i).padStart(3, '0')}`));
    expect(pages.at(-1).length).toBe(TOTAL % 7);
  });
});
