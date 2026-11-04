// Idempotency-Key support. The first request with a key is processed and its successful response
// is stored for 24 hours. A retry with the same key and body gets the stored response; the same key
// with a different body gets 409 CONFLICT. Failed requests are not stored, so they can be retried.

import crypto from 'node:crypto';
import { IdempotencyRecord } from '../models/IdempotencyRecord.js';
import { ApiError } from '../utils/ApiError.js';
import { readIdempotencyKey } from '../validators/common.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;

// Hashes the route, path parameters and body, so "same request" can be compared cheaply.
function fingerprintRequest(route, req) {
  const content = JSON.stringify({ route, params: req.params, body: req.body ?? null });
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Sends a stored response again, with this request's own request id.
function replayStoredResponse(res, record) {
  const body = { ...record.responseBody, meta: { requestId: res.locals.requestId } };
  return res.status(record.responseStatus).json(body);
}

// Claims the key for this request. Returns the existing record when the key was already used.
async function claimKey(userId, key, route, fingerprint) {
  try {
    await IdempotencyRecord.create({
      userId,
      key,
      route,
      requestFingerprint: fingerprint,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });
    return null;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return IdempotencyRecord.findOne({ userId, key });
  }
}

// Stores a successful response for replays, or releases the key when the request failed.
async function saveOutcome(userId, key, statusCode, body) {
  if (statusCode >= 200 && statusCode < 300) {
    await IdempotencyRecord.updateOne(
      { userId, key },
      { $set: { state: 'COMPLETED', responseStatus: statusCode, responseBody: body } },
    );
  } else {
    await IdempotencyRecord.deleteOne({ userId, key, state: 'IN_PROGRESS' });
  }
}

// Middleware for endpoints marked "Idempotent". Must run after requireAuth.
export async function requireIdempotency(req, res, next) {
  const key = readIdempotencyKey(req);
  const userId = req.user.id;
  const route = `${req.method} ${req.baseUrl}${req.route.path}`;
  const fingerprint = fingerprintRequest(route, req);

  let existing = await claimKey(userId, key, route, fingerprint);
  if (existing && existing.expiresAt <= new Date()) {
    await IdempotencyRecord.deleteOne({ _id: existing._id });
    existing = await claimKey(userId, key, route, fingerprint);
  }

  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw ApiError.conflict('This Idempotency-Key was already used for a different request.', [
        { field: 'Idempotency-Key', reason: 'REUSED' },
      ]);
    }
    if (existing.state !== 'COMPLETED') throw ApiError.conflict('This request is still being processed.');
    return replayStoredResponse(res, existing);
  }

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    saveOutcome(userId, key, res.statusCode, body)
      .catch(() => {})
      .finally(() => sendJson(body));
    return res;
  };
  next();
}
