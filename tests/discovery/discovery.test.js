// Tests GET /discovery: every exclusion rule, two-way preference matching, distance and pagination.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Swipe } from '../../src/models/Swipe.js';
import { User } from '../../src/models/User.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();
const PUNE = { type: 'Point', coordinates: [73.86, 18.52] };
const DELHI = { type: 'Point', coordinates: [77.21, 28.61] };

// Returns the ids in one discovery page for a member.
async function discoverIds(member, query = '') {
  const res = await request(app).get(`/api/v1/discovery${query}`).set(bearer(member.token));
  expect(res.status).toBe(200);
  return res.body.data.items.map((item) => item.id);
}

describe('GET /discovery', () => {
  useTestDatabase();

  it('returns public profiles of other members, never the viewer', async () => {
    const viewer = await createMember();
    const other = await createMember({ profile: { displayName: 'Avery' } });

    const res = await request(app).get('/api/v1/discovery').set(bearer(viewer.token));
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ id: other.id, displayName: 'Avery', age: 28 });
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.items[0].phoneNumber).toBeUndefined();
  });

  it('excludes members already swiped', async () => {
    const viewer = await createMember();
    const swiped = await createMember();
    const fresh = await createMember();
    await Swipe.create({ userId: viewer.id, targetUserId: swiped.id, action: 'PASS' });
    expect(await discoverIds(viewer)).toEqual([fresh.id]);
  });

  it('excludes matches', async () => {
    const viewer = await createMember();
    const matched = await createMember();
    await matchMembers(app, viewer, matched);
    expect(await discoverIds(viewer)).toEqual([]);
  });

  it('excludes blocks in both directions', async () => {
    const viewer = await createMember();
    const blockedByViewer = await createMember();
    const blockingViewer = await createMember();
    await Block.create({ blockerId: viewer.id, blockedId: blockedByViewer.id });
    await Block.create({ blockerId: blockingViewer.id, blockedId: viewer.id });
    expect(await discoverIds(viewer)).toEqual([]);
  });

  it('excludes suspended, banned, deleting and not-onboarded members', async () => {
    const viewer = await createMember();
    await createMember({ user: { status: 'SUSPENDED' } });
    await createMember({ user: { status: 'BANNED' } });
    await createMember({ user: { deletion: { status: 'SCHEDULED' } } });
    await createMember({ user: { onboardingComplete: false } });
    const expiredSuspension = await createMember({ user: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() - 1000) } });
    expect(await discoverIds(viewer)).toEqual([expiredSuspension.id]);
  });

  it('applies the viewer\'s gender preference', async () => {
    const viewer = await createMember({ profile: { gender: 'WOMAN', preferences: { showMe: 'MEN' } } });
    const man = await createMember({ profile: { gender: 'MAN' } });
    await createMember({ profile: { gender: 'WOMAN' } });
    expect(await discoverIds(viewer)).toEqual([man.id]);
  });

  it('applies the candidate\'s preferences to the viewer (gender and age)', async () => {
    const viewer = await createMember({ profile: { gender: 'MAN', age: 40 } });
    await createMember({ profile: { preferences: { showMe: 'WOMEN' } } });
    await createMember({ profile: { preferences: { maxAge: 35 } } });
    const accepting = await createMember({ profile: { preferences: { showMe: 'MEN', maxAge: 45 } } });
    expect(await discoverIds(viewer)).toEqual([accepting.id]);
  });

  it('filters by age with minAge and maxAge', async () => {
    const viewer = await createMember();
    const young = await createMember({ profile: { age: 22 } });
    const older = await createMember({ profile: { age: 45 } });
    expect(await discoverIds(viewer, '?minAge=18&maxAge=30')).toEqual([young.id]);
    expect(await discoverIds(viewer, '?minAge=40&maxAge=60')).toEqual([older.id]);
  });

  it('filters by distance when both members shared a location', async () => {
    const viewer = await createMember({ profile: { location: PUNE } });
    const near = await createMember({ profile: { location: { type: 'Point', coordinates: [73.9, 18.55] } } });
    await createMember({ profile: { location: DELHI } });
    const noLocation = await createMember();

    const ids = await discoverIds(viewer, '?distanceKm=50');
    expect(ids.sort()).toEqual([near.id, noLocation.id].sort());
  });

  it('respects the candidate\'s own distance limit', async () => {
    const viewer = await createMember({ profile: { location: PUNE, preferences: { maxDistanceKm: 500 } } });
    await createMember({ profile: { location: { type: 'Point', coordinates: [75.0, 19.0] }, preferences: { maxDistanceKm: 10 } } });
    expect(await discoverIds(viewer)).toEqual([]);
  });

  it('paginates without duplicates', async () => {
    const viewer = await createMember();
    const created = [];
    for (let index = 0; index < 5; index += 1) created.push((await createMember()).id);

    const seen = [];
    let cursor = '';
    let pages = 0;
    do {
      const res = await request(app).get(`/api/v1/discovery?limit=2&cursor=${cursor}`).set(bearer(viewer.token));
      seen.push(...res.body.data.items.map((item) => item.id));
      cursor = res.body.data.nextCursor ?? '';
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(created.sort());
  });

  it('fills pages even when hidden members are skipped', async () => {
    const viewer = await createMember();
    const visible = await createMember();
    for (let index = 0; index < 4; index += 1) await createMember({ user: { status: 'BANNED' } });
    expect(await discoverIds(viewer, '?limit=2')).toEqual([visible.id]);
  });

  it.each([
    ['?minAge=30&maxAge=20', 'maxAge'],
    ['?minAge=17', 'minAge'],
    ['?distanceKm=0', 'distanceKm'],
    ['?limit=0', 'limit'],
    ['?limit=51', 'limit'],
    ['?cursor=not-a-cursor', 'cursor'],
  ])('rejects %s', async (query, field) => {
    const viewer = await createMember();
    const res = await request(app).get(`/api/v1/discovery${query}`).set(bearer(viewer.token));
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((detail) => detail.field)).toContain(field);
  });

  it('requires authentication and onboarding', async () => {
    expect((await request(app).get('/api/v1/discovery')).status).toBe(401);
    const member = await createMember();
    await User.updateOne({ _id: member.id }, { $set: { onboardingComplete: false } });
    const res = await request(app).get('/api/v1/discovery').set(bearer(member.token));
    expect(res.status).toBe(409);
  });
});
