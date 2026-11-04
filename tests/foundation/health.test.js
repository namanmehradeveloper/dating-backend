// Tests GET /api/v1/health: the success payload, request ids, security headers and the database-down case.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectDB, getDbState } from '../../src/config/db.js';
import { closeTestDb, connectTestDb } from '../helpers/db.js';

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

describe('GET /api/v1/health', () => {
  const app = createApp();

  beforeAll(connectTestDb);
  afterAll(closeTestDb);

  it('returns 200 with status, database, environment, uptime and timestamp', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json; charset=utf-8/);
    expect(res.body).toEqual({
      success: true,
      data: {
        status: 'ok',
        database: 'connected',
        environment: 'test',
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      },
      meta: { requestId: expect.stringMatching(REQUEST_ID) },
    });
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
    expect(new Date(res.body.data.timestamp).toISOString()).toBe(res.body.data.timestamp);
  });

  it('echoes the request id in the X-Request-Id header', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('generates a new request id per request and ignores client-supplied ids', async () => {
    const first = await request(app).get('/api/v1/health').set('X-Request-Id', 'req_spoofed');
    const second = await request(app).get('/api/v1/health');
    expect(first.body.meta.requestId).not.toBe('req_spoofed');
    expect(first.body.meta.requestId).not.toBe(second.body.meta.requestId);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('reports 503 with the database state when MongoDB is not connected', async () => {
    await disconnectDB();
    expect(getDbState()).toBe('disconnected');

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'The service is temporarily unavailable.',
        details: [{ field: 'database', reason: 'DISCONNECTED' }],
      },
      meta: { requestId: expect.stringMatching(REQUEST_ID) },
    });

    await connectTestDb();
    expect(getDbState()).toBe('connected');
  });
});
