// Tests the 404 handler, malformed JSON handling, the global error handler, ApiError and ApiResponse.

import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { errorHandler, notFound } from '../../src/middlewares/error.middleware.js';
import { requestId } from '../../src/middlewares/requestId.middleware.js';
import { ApiError, ERROR_CODES } from '../../src/utils/ApiError.js';
import { ApiResponse } from '../../src/utils/ApiResponse.js';
import { asyncHandler } from '../../src/utils/asyncHandler.js';

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

// Asserts that a response uses the documented error envelope with the given status and code.
function expectErrorEnvelope(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    success: false,
    error: { code, message: expect.any(String), details: expect.any(Array) },
    meta: { requestId: expect.stringMatching(REQUEST_ID) },
  });
  expect(res.body.error.message.length).toBeGreaterThan(0);
  expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
}

// Builds a minimal app with the real middlewares plus test routes that throw on purpose.
function buildApp(register) {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  register(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const Probe = mongoose.model(
  'ErrorProbe',
  new mongoose.Schema({ name: { type: String, required: true }, age: { type: Number, min: 18 } }),
);

describe('real app: unknown routes and bad bodies', () => {
  const app = createApp();

  it.each(['/api/v1/does-not-exist', '/api/v1', '/unknown', '/'])('GET %s returns the 404 envelope', async (path) => {
    const res = await request(app).get(path);
    expectErrorEnvelope(res, 404, 'NOT_FOUND');
    expect(res.body.error.details).toEqual([]);
  });

  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"phoneNumber": "+91');

    expectErrorEnvelope(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'body', reason: 'INVALID_JSON' }]);
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|Unexpected|at JSON/);
  });

  it('rejects non-object JSON roots (strict mode)', async () => {
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('"text"');
    expectErrorEnvelope(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'body', reason: 'INVALID_JSON' }]);
  });

  it('rejects oversized JSON bodies', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ bio: 'x'.repeat(200 * 1024) }));

    expectErrorEnvelope(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'body', reason: 'PAYLOAD_TOO_LARGE' }]);
  });
});

describe('error handler', () => {
  const app = buildApp((a) => {
    a.get('/api-error', () => {
      throw ApiError.conflict('You already responded to this profile.', [{ field: 'targetUserId', reason: 'ALREADY_SWIPED' }]);
    });
    a.get(
      '/async-api-error',
      asyncHandler(async () => {
        throw new ApiError('SUBSCRIPTION_REQUIRED', { details: [{ field: 'quota', reason: 'DAILY_LIKES_EXHAUSTED' }] });
      }),
    );
    a.get(
      '/async-crash',
      asyncHandler(async () => {
        throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@db/secret');
      }),
    );
    a.get('/sync-crash', () => {
      null.boom();
    });
    a.get('/rate-limited', () => {
      throw ApiError.rateLimited(42);
    });
    a.get('/mongoose-validation', async () => {
      await new Probe({ age: 12 }).validate();
    });
    a.get('/duplicate-key', () => {
      const err = new Error('E11000 duplicate key error collection: users index: phoneNumber_1 dup key: { phoneNumber: "+919876543210" }');
      err.code = 11000;
      throw err;
    });
    a.get('/cast-error', () => {
      throw new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
    });
    a.get('/not-configured', () => {
      throw new ApiError('FEATURE_NOT_CONFIGURED');
    });
  });

  it('serialises ApiError with its status, code, message and details', async () => {
    const res = await request(app).get('/api-error');
    expectErrorEnvelope(res, 409, 'CONFLICT');
    expect(res.body.error.message).toBe('You already responded to this profile.');
    expect(res.body.error.details).toEqual([{ field: 'targetUserId', reason: 'ALREADY_SWIPED' }]);
  });

  it('forwards async ApiErrors through asyncHandler', async () => {
    const res = await request(app).get('/async-api-error');
    expectErrorEnvelope(res, 403, 'SUBSCRIPTION_REQUIRED');
    expect(res.body.error.details).toEqual([{ field: 'quota', reason: 'DAILY_LIKES_EXHAUSTED' }]);
  });

  it.each(['/async-crash', '/sync-crash'])('hides unknown errors behind SERVER_ERROR (%s)', async (path) => {
    const res = await request(app).get(path);
    expectErrorEnvelope(res, 500, 'SERVER_ERROR');
    expect(res.body.error.message).toBe('Something went wrong. Please try again.');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/hunter2|mongodb|ECONNREFUSED|stack|TypeError|null/i);
  });

  it('sets Retry-After on RATE_LIMITED', async () => {
    const res = await request(app).get('/rate-limited');
    expectErrorEnvelope(res, 429, 'RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('42');
  });

  it('maps Mongoose validation errors to field details without internals', async () => {
    const res = await request(app).get('/mongoose-validation');
    expectErrorEnvelope(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'name', reason: 'REQUIRED' },
        { field: 'age', reason: 'OUT_OF_RANGE' },
      ]),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/Path|ValidatorError|ErrorProbe/);
  });

  it('maps duplicate-key errors to CONFLICT without leaking the key', async () => {
    const res = await request(app).get('/duplicate-key');
    expectErrorEnvelope(res, 409, 'CONFLICT');
    expect(JSON.stringify(res.body)).not.toMatch(/E11000|phoneNumber|\+91/);
  });

  it('maps cast errors (malformed ids) to NOT_FOUND', async () => {
    const res = await request(app).get('/cast-error');
    expectErrorEnvelope(res, 404, 'NOT_FOUND');
  });

  it('returns 501 for FEATURE_NOT_CONFIGURED', async () => {
    const res = await request(app).get('/not-configured');
    expectErrorEnvelope(res, 501, 'FEATURE_NOT_CONFIGURED');
  });
});

describe('ApiError', () => {
  it.each(Object.entries(ERROR_CODES))('%s defaults to HTTP %i with a user-safe message', (code, status) => {
    const err = new ApiError(code);
    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.details).toEqual([]);
  });

  it('matches the documented status for every code', () => {
    expect(ERROR_CODES).toEqual({
      VALIDATION_ERROR: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      OTP_INVALID: 400,
      OTP_EXPIRED: 400,
      ACCOUNT_INELIGIBLE: 403,
      USER_BLOCKED: 403,
      MATCH_REQUIRED: 403,
      SUBSCRIPTION_REQUIRED: 403,
      MEDIA_REJECTED: 422,
      SERVER_ERROR: 500,
      FEATURE_NOT_CONFIGURED: 501,
    });
  });

  it('rejects undocumented codes', () => {
    expect(() => new ApiError('TEAPOT')).toThrow(TypeError);
  });

  it('allows an explicit status override (e.g. 422 validation)', () => {
    expect(new ApiError('VALIDATION_ERROR', { statusCode: 422 }).statusCode).toBe(422);
  });
});

describe('ApiResponse', () => {
  const app = buildApp((a) => {
    a.get('/ok', (req, res) => ApiResponse.ok(res, { id: 'usr_demo_001' }));
    a.get('/null', (req, res) => ApiResponse.ok(res));
    a.get('/created', (req, res) => ApiResponse.created(res, { id: 'msg_1' }));
    a.get('/accepted', (req, res) => ApiResponse.accepted(res, { status: 'PENDING' }));
    a.get('/page', (req, res) => ApiResponse.paginated(res, { items: [{ id: 'a' }] }));
  });

  it.each([
    ['/ok', 200, { id: 'usr_demo_001' }],
    ['/null', 200, null],
    ['/created', 201, { id: 'msg_1' }],
    ['/accepted', 202, { status: 'PENDING' }],
    ['/page', 200, { items: [{ id: 'a' }], nextCursor: null }],
  ])('%s uses the success envelope', async (path, status, data) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ success: true, data, meta: { requestId: expect.stringMatching(REQUEST_ID) } });
  });
});
