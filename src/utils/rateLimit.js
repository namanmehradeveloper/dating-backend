// Builds the documented rate limits (express-rate-limit with in-memory stores).
// Limits are keyed by IP, by the signed-in user, or by a value from the request (phone number, conversation).

import { rateLimit, ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import { ApiError } from './ApiError.js';

const allStores = [];

// Builds the key for a limiter: "<scope>:<value>", where value comes from `keyFrom(req)`.
function buildKey(req, keyFrom) {
  const value = keyFrom(req);
  return value === undefined || value === null || value === '' ? 'unknown' : String(value);
}

// Key helpers used by route files.
export const byIp = (req) => ipKeyGenerator(req.ip ?? '');
export const byUser = (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '');

// Creates a rate-limit middleware that answers 429 RATE_LIMITED with a Retry-After header.
// `max` requests are allowed per `windowMs` for each key returned by `keyFrom`.
export function createRateLimiter({ windowMs, max, keyFrom = byIp, message }) {
  const store = new MemoryStore();
  allStores.push(store);

  return rateLimit({
    windowMs,
    limit: max,
    store,
    standardHeaders: false,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => buildKey(req, keyFrom),
    handler: (req, res, next) => {
      const resetTime = req.rateLimit?.resetTime;
      const retryAfterSeconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
      next(ApiError.rateLimited(retryAfterSeconds, message));
    },
  });
}

// Clears every in-memory counter. Tests call this between cases so limits do not leak across tests.
export async function resetRateLimits() {
  await Promise.all(allStores.map((store) => store.resetAll()));
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
