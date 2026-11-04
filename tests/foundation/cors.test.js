// Tests CORS for direct browser calls from the React admin (no proxy) and for Flutter's origin-less requests.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('CORS (direct browser calls from the React admin, no proxy)', () => {
  const app = createApp();
  const path = '/api/v1/unknown-route';

  it.each(['http://127.0.0.1:5173', 'http://localhost:5173'])('allows the local admin origin %s', async (origin) => {
    const res = await request(app).get(path).set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/);
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/);
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it('sends no CORS headers to an unlisted origin', async () => {
    const res = await request(app).get(path).set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never uses a wildcard origin or credentials', async () => {
    const res = await request(app).get(path).set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers preflight for Bearer auth and Idempotency-Key', async () => {
    const res = await request(app)
      .options('/api/v1/swipes')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toMatch(/PATCH/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/);
  });

  it('serves requests without an Origin header (Flutter native apps)', async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
