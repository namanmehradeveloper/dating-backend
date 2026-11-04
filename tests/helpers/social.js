// Helpers for tests that need swipes, matches and conversations between members.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { bearer } from './factories.js';

// Sends POST /swipes with a fresh (or given) Idempotency-Key.
export function swipe(app, member, targetUserId, action = 'LIKE', key = uuidv4()) {
  return request(app)
    .post('/api/v1/swipes')
    .set(bearer(member.token))
    .set('Idempotency-Key', key)
    .send({ targetUserId, action });
}

// Makes two members like each other and returns the match from the second like.
export async function matchMembers(app, first, second) {
  await swipe(app, first, second.id, 'LIKE');
  const res = await swipe(app, second, first.id, 'LIKE');
  return res.body.data.match;
}
