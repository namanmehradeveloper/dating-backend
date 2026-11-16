// Virtual store: catalogue, demo coin packs, buy-with-coins, and gift/paid-emoji chat sends.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Message } from '../../src/models/Message.js';
import { Wallet } from '../../src/models/Wallet.js';
import { bearer, createMember, createStaff, useTestDatabase } from '../helpers/factories.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

describe('virtual store', () => {
  useTestDatabase();
  let member;

  beforeEach(async () => {
    member = await createMember({ profile: { displayName: 'Casey' } });
  });

  it('lists seeded catalogue items', async () => {
    const res = await request(app).get('/api/v1/store/catalog').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.coinPacks.length).toBeGreaterThan(0);
    expect(res.body.data.emojiPacks.length).toBeGreaterThan(0);
    expect(res.body.data.gifts.length).toBeGreaterThan(0);
    expect(res.body.data.gifts[0]).toMatchObject({
      id: expect.any(String),
      kind: 'GIFT',
      priceCoins: expect.any(Number),
    });
  });

  it('starts with an empty wallet', async () => {
    const res = await request(app).get('/api/v1/store/wallet').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      coinBalance: 0,
      ownedPackIds: [],
      giftInventory: [],
    });
  });

  it('credits coins after a successful demo checkout', async () => {
    const checkout = await request(app)
      .post('/api/v1/store/checkout')
      .set(bearer(member.token))
      .send({ itemId: 'coins_100', platform: 'WEB' });
    expect(checkout.status).toBe(200);
    expect(checkout.body.data.checkoutId).toMatch(/^store_/);
    expect(checkout.body.data.isDemo).toBe(true);

    const verify = await request(app)
      .post('/api/v1/store/verify')
      .set(bearer(member.token))
      .send({ checkoutId: checkout.body.data.checkoutId, providerProof: { outcome: 'SUCCESS' } });
    expect(verify.status).toBe(200);
    expect(verify.body.data.purchase.status).toBe('SUCCEEDED');
    expect(verify.body.data.wallet.coinBalance).toBe(100);

    const replay = await request(app)
      .post('/api/v1/store/verify')
      .set(bearer(member.token))
      .send({ checkoutId: checkout.body.data.checkoutId, providerProof: { outcome: 'SUCCESS' } });
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.wallet.coinBalance).toBe(100);
  });

  it('buys an emoji pack with coins and rejects a second purchase', async () => {
    await Wallet.create({ _id: member.id, userId: member.id, coinBalance: 200 });

    const buy = await request(app)
      .post('/api/v1/store/buy-with-coins')
      .set(bearer(member.token))
      .send({ itemId: 'emoji_pack_hearts' });
    expect(buy.status).toBe(200);
    expect(buy.body.data.wallet.ownedPackIds).toContain('emoji_pack_hearts');
    expect(buy.body.data.wallet.coinBalance).toBe(120);

    const again = await request(app)
      .post('/api/v1/store/buy-with-coins')
      .set(bearer(member.token))
      .send({ itemId: 'emoji_pack_hearts' });
    expect(again.status).toBe(409);
  });

  it('rejects gift checkout for non coin packs', async () => {
    const res = await request(app)
      .post('/api/v1/store/checkout')
      .set(bearer(member.token))
      .send({ itemId: 'gift_rose', platform: 'WEB' });
    expect(res.status).toBe(400);
  });

  it('sends a gift in chat by deducting coins', async () => {
    const peer = await createMember({ profile: { displayName: 'Riley' } });
    const match = await matchMembers(app, member, peer);
    await Wallet.create({ _id: member.id, userId: member.id, coinBalance: 50 });

    const clientMessageId = uuidv4();
    const res = await request(app)
      .post(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(member.token))
      .set('Idempotency-Key', clientMessageId)
      .send({ giftItemId: 'gift_rose', clientMessageId });

    expect(res.status).toBe(201);
    expect(res.body.data.gift).toMatchObject({
      itemId: 'gift_rose',
      title: 'Rose',
      emoji: '🌹',
      priceCoins: 25,
    });
    expect(res.body.data.text).toBe('');
    expect(await Wallet.findById(member.id).then((w) => w.coinBalance)).toBe(25);

    const retry = await request(app)
      .post(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(member.token))
      .set('Idempotency-Key', clientMessageId)
      .send({ giftItemId: 'gift_rose', clientMessageId });
    expect(retry.body.data.id).toBe(res.body.data.id);
    expect(await Wallet.findById(member.id).then((w) => w.coinBalance)).toBe(25);
    expect(await Message.countDocuments({ 'gift.itemId': 'gift_rose' })).toBe(1);
  });

  it('rejects gift send when the wallet has too few coins', async () => {
    const peer = await createMember({ profile: { displayName: 'Jordan' } });
    const match = await matchMembers(app, member, peer);
    await Wallet.create({ _id: member.id, userId: member.id, coinBalance: 5 });
    const clientMessageId = uuidv4();
    const res = await request(app)
      .post(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(member.token))
      .set('Idempotency-Key', clientMessageId)
      .send({ giftItemId: 'gift_rose', clientMessageId });
    expect(res.status).toBe(403);
  });

  it('sends a paid emoji only when the pack is owned', async () => {
    const peer = await createMember({ profile: { displayName: 'Sam' } });
    const match = await matchMembers(app, member, peer);
    await Wallet.create({ _id: member.id, userId: member.id, coinBalance: 200 });
    await request(app)
      .post('/api/v1/store/buy-with-coins')
      .set(bearer(member.token))
      .send({ itemId: 'emoji_pack_hearts' });

    const clientMessageId = uuidv4();
    const res = await request(app)
      .post(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(member.token))
      .set('Idempotency-Key', clientMessageId)
      .send({ paidEmoji: { packId: 'emoji_pack_hearts', emoji: '💕' }, clientMessageId });
    expect(res.status).toBe(201);
    expect(res.body.data.paidEmoji).toEqual({
      packId: 'emoji_pack_hearts',
      packTitle: 'Hearts Pack',
      emoji: '💕',
    });
  });

  it('allows admin to list and disable catalogue items', async () => {
    const admin = await createStaff('ADMIN');
    const list = await request(app).get('/api/v1/admin/store/items').set(bearer(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBeGreaterThan(0);

    const patch = await request(app)
      .patch('/api/v1/admin/store/items/gift_rose')
      .set(bearer(admin.token))
      .send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.isActive).toBe(false);

    const catalog = await request(app).get('/api/v1/store/catalog').set(bearer(member.token));
    expect(catalog.body.data.gifts.find((item) => item.id === 'gift_rose')).toBeUndefined();
  });
});
