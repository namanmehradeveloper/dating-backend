// Atomic daily support-ticket quota (5 creates per member or guest IP per rolling 24h).
// Idempotent retries never call this — requireIdempotency replays before the handler runs.

import { SupportTicketQuota } from '../models/SupportTicketQuota.js';
import { ApiError } from '../utils/ApiError.js';
import { DAY } from '../utils/rateLimit.js';

export const TICKET_DAILY_LIMIT = 5;
const LIMIT_MESSAGE = 'You can open up to 5 support tickets per day. Please try again later.';

export function ticketQuotaKey({ userId, ipKey }) {
  if (userId) return `user:${userId}`;
  return `ip:${ipKey || 'unknown'}`;
}

// Reserves one create slot. Concurrent callers cannot push the same window past the limit.
export async function consumeTicketQuota(key, { max = TICKET_DAILY_LIMIT, windowMs = DAY } = {}) {
  const now = new Date();
  const nextWindowEnd = new Date(now.getTime() + windowMs);

  const underLimit = await SupportTicketQuota.findOneAndUpdate(
    { key, windowEndsAt: { $gt: now }, count: { $lt: max } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' },
  );
  if (underLimit) return underLimit;

  const resetExpired = await SupportTicketQuota.findOneAndUpdate(
    { key, windowEndsAt: { $lte: now } },
    { $set: { count: 1, windowEndsAt: nextWindowEnd } },
    { returnDocument: 'after' },
  );
  if (resetExpired) return resetExpired;

  try {
    return await SupportTicketQuota.create({ key, count: 1, windowEndsAt: nextWindowEnd });
  } catch (error) {
    if (error?.code !== 11000) throw error;

    const afterRace = await SupportTicketQuota.findOneAndUpdate(
      { key, windowEndsAt: { $gt: new Date() }, count: { $lt: max } },
      { $inc: { count: 1 } },
      { returnDocument: 'after' },
    );
    if (afterRace) return afterRace;

    const resetAfterRace = await SupportTicketQuota.findOneAndUpdate(
      { key, windowEndsAt: { $lte: new Date() } },
      { $set: { count: 1, windowEndsAt: new Date(Date.now() + windowMs) } },
      { returnDocument: 'after' },
    );
    if (resetAfterRace) return resetAfterRace;

    const current = await SupportTicketQuota.findOne({ key }).lean();
    const retryAfterSeconds = current?.windowEndsAt
      ? Math.max(1, Math.ceil((new Date(current.windowEndsAt).getTime() - Date.now()) / 1000))
      : Math.ceil(windowMs / 1000);
    throw ApiError.rateLimited(retryAfterSeconds, LIMIT_MESSAGE);
  }
}

// Rolls back a reserved slot when ticket creation fails after consume.
export async function releaseTicketQuota(key) {
  const now = new Date();
  await SupportTicketQuota.findOneAndUpdate(
    { key, windowEndsAt: { $gt: now }, count: { $gt: 0 } },
    { $inc: { count: -1 } },
  );
}
