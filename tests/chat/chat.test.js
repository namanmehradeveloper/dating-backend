// Tests chat REST: membership, pagination, validation, idempotent sends, blocks, unmatch,
// read receipts and the message rate limits.

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Block } from '../../src/models/Block.js';
import { Message } from '../../src/models/Message.js';
import { bearer, createMember, useTestDatabase } from '../helpers/factories.js';
import { makeImage } from '../helpers/images.js';
import { matchMembers } from '../helpers/social.js';

const app = createApp();

// Sends a chat message with clientMessageId = Idempotency-Key.
function sendMessage(member, conversationId, text = 'Hello', clientMessageId = uuidv4()) {
  return sendMessageBody(member, conversationId, { text, clientMessageId });
}

// Sends any message body; the Idempotency-Key header follows body.clientMessageId.
function sendMessageBody(member, conversationId, body) {
  return request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(bearer(member.token))
    .set('Idempotency-Key', body.clientMessageId)
    .send(body);
}

// Uploads a small JPEG and returns its media record.
async function uploadImage(member, purpose = 'CHAT_ATTACHMENT') {
  const res = await request(app)
    .post('/api/v1/media/upload')
    .set(bearer(member.token))
    .field('purpose', purpose)
    .attach('file', await makeImage('jpeg'), { filename: 'photo.jpg', contentType: 'image/jpeg' });
  return res.body.data;
}

describe('chat REST', () => {
  useTestDatabase();
  let alex;
  let avery;
  let match;

  beforeEach(async () => {
    alex = await createMember({ profile: { displayName: 'Alex' } });
    avery = await createMember({ profile: { displayName: 'Avery' } });
    match = await matchMembers(app, alex, avery);
  });

  it('sends a message and returns it with status SENT', async () => {
    const clientMessageId = uuidv4();
    const res = await sendMessage(alex, match.conversationId, '  Hi Avery!  ', clientMessageId);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.stringMatching(/^msg_/),
      conversationId: match.conversationId,
      senderId: alex.id,
      text: 'Hi Avery!',
      attachment: null,
      call: null,
      sentAt: expect.any(String),
      status: 'SENT',
      clientMessageId,
    });
  });

  it('returns the same message for a retried send', async () => {
    const clientMessageId = uuidv4();
    const first = await sendMessage(alex, match.conversationId, 'Hello', clientMessageId);
    const retry = await sendMessage(alex, match.conversationId, 'Hello', clientMessageId);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await Message.countDocuments()).toBe(1);
  });

  it('requires Idempotency-Key to equal clientMessageId', async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${match.conversationId}/messages`)
      .set(bearer(alex.token))
      .set('Idempotency-Key', uuidv4())
      .send({ text: 'Hi', clientMessageId: uuidv4() });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('Idempotency-Key');
  });

  it.each(['', '   ', 'x'.repeat(1001)])('rejects text %j', async (text) => {
    const res = await sendMessage(alex, match.conversationId, text);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'text', reason: 'LENGTH_1_1000' }]);
  });

  it('accepts exactly 1000 characters', async () => {
    expect((await sendMessage(alex, match.conversationId, 'x'.repeat(1000))).status).toBe(201);
  });

  it('hides conversations from non-participants', async () => {
    const outsider = await createMember();
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(outsider.token))).status).toBe(404);
    expect((await sendMessage(outsider, match.conversationId)).status).toBe(404);
  });

  it('lists conversations with last message and unread count', async () => {
    await sendMessage(alex, match.conversationId, 'First');
    await sendMessage(alex, match.conversationId, 'Second');

    const res = await request(app).get('/api/v1/conversations').set(bearer(avery.token));
    expect(res.body.data.items).toEqual([
      {
        id: match.conversationId,
        matchId: match.id,
        otherUser: expect.objectContaining({ id: alex.id, displayName: 'Alex', isOnline: false }),
        lastMessage: expect.objectContaining({ text: 'Second', senderId: alex.id }),
        unreadCount: 2,
      },
    ]);
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}`).set(bearer(avery.token))).body.data.unreadCount).toBe(2);
  });

  it('paginates messages oldest-first within a page, with nextCursor loading older ones', async () => {
    for (const text of ['one', 'two', 'three', 'four', 'five']) await sendMessage(alex, match.conversationId, text);

    const newest = await request(app).get(`/api/v1/conversations/${match.conversationId}/messages?limit=2`).set(bearer(avery.token));
    expect(newest.body.data.items.map((message) => message.text)).toEqual(['four', 'five']);

    const older = await request(app)
      .get(`/api/v1/conversations/${match.conversationId}/messages?limit=2&cursor=${newest.body.data.nextCursor}`)
      .set(bearer(avery.token));
    expect(older.body.data.items.map((message) => message.text)).toEqual(['two', 'three']);

    const oldest = await request(app)
      .get(`/api/v1/conversations/${match.conversationId}/messages?limit=2&cursor=${older.body.data.nextCursor}`)
      .set(bearer(avery.token));
    expect(oldest.body.data.items.map((message) => message.text)).toEqual(['one']);
    expect(oldest.body.data.nextCursor).toBeNull();
  });

  it('marks messages read up to the given message', async () => {
    const first = (await sendMessage(alex, match.conversationId, 'one')).body.data;
    const second = (await sendMessage(alex, match.conversationId, 'two')).body.data;
    await sendMessage(alex, match.conversationId, 'three');

    const res = await request(app).post(`/api/v1/messages/${second.id}/read`).set(bearer(avery.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ conversationId: match.conversationId, readerId: avery.id, upToMessageId: second.id });

    const messages = (await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(alex.token))).body.data.items;
    expect(messages.map((message) => message.status)).toEqual(['READ', 'READ', 'SENT']);
    expect(first.status).toBe('SENT');
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}`).set(bearer(avery.token))).body.data.unreadCount).toBe(1);

    const duplicate = await request(app).post(`/api/v1/messages/${second.id}/read`).set(bearer(avery.token));
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.upToMessageId).toBe(second.id);

    expect((await request(app).post(`/api/v1/messages/${first.id}/read`).set(bearer(alex.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(alex.token))).body.data.items.map((message) => message.status)).toEqual([
      'READ',
      'READ',
      'SENT',
    ]);

    const outsider = await createMember();
    expect((await request(app).post(`/api/v1/messages/${second.id}/read`).set(bearer(outsider.token))).status).toBe(404);
  });

  it('answers MATCH_REQUIRED after an unmatch', async () => {
    await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(avery.token));
    const res = await sendMessage(alex, match.conversationId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MATCH_REQUIRED');
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(alex.token))).body.error.code).toBe('MATCH_REQUIRED');
    expect((await request(app).get('/api/v1/conversations').set(bearer(alex.token))).body.data.items).toEqual([]);
  });

  it('answers USER_BLOCKED to the blocker and MATCH_REQUIRED to the blocked member', async () => {
    await Block.create({ blockerId: alex.id, blockedId: avery.id });
    expect((await sendMessage(alex, match.conversationId)).body.error.code).toBe('USER_BLOCKED');
    expect((await sendMessage(avery, match.conversationId)).body.error.code).toBe('MATCH_REQUIRED');
  });

  it('limits messages to 30 per minute per conversation', async () => {
    for (let index = 0; index < 30; index += 1) {
      expect((await sendMessage(alex, match.conversationId, `m${index}`)).status).toBe(201);
    }
    const res = await sendMessage(alex, match.conversationId, 'one too many');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect((await sendMessage(avery, match.conversationId, 'other member is fine')).status).toBe(201);
  });

  it('deletes a chat for the current member only and restores it on a new message', async () => {
    await sendMessage(alex, match.conversationId, 'Keep me');

    const deleted = await request(app).delete(`/api/v1/conversations/${match.conversationId}`).set(bearer(alex.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ conversationId: match.conversationId });

    expect((await request(app).get('/api/v1/conversations').set(bearer(alex.token))).body.data.items).toEqual([]);
    expect((await request(app).get(`/api/v1/conversations/${match.conversationId}`).set(bearer(alex.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/conversations').set(bearer(avery.token))).body.data.items).toHaveLength(1);

    await sendMessage(avery, match.conversationId, 'Bring it back');
    expect((await request(app).get('/api/v1/conversations').set(bearer(alex.token))).body.data.items).toHaveLength(1);
  });

  it('deletes a message for the current member only', async () => {
    const kept = (await sendMessage(alex, match.conversationId, 'kept')).body.data;
    const hidden = (await sendMessage(alex, match.conversationId, 'hidden')).body.data;

    const deleted = await request(app).delete(`/api/v1/messages/${hidden.id}`).set(bearer(avery.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({
      conversationId: match.conversationId,
      messageId: hidden.id,
      scope: 'ME',
    });

    expect(
      (await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(avery.token))).body.data.items.map(
        (message) => message.id,
      ),
    ).toEqual([kept.id]);
    expect(
      (await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(alex.token))).body.data.items.map(
        (message) => message.id,
      ),
    ).toEqual([kept.id, hidden.id]);
  });

  it('lets the sender unsend a message for everyone', async () => {
    const message = (await sendMessage(alex, match.conversationId, 'oops')).body.data;

    const outsider = await createMember();
    expect((await request(app).post(`/api/v1/messages/${message.id}/unsend`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).post(`/api/v1/messages/${message.id}/unsend`).set(bearer(avery.token))).status).toBe(404);

    const unsent = await request(app).post(`/api/v1/messages/${message.id}/unsend`).set(bearer(alex.token));
    expect(unsent.status).toBe(200);
    expect(unsent.body.data).toMatchObject({
      id: message.id,
      text: '',
      attachment: null,
      call: null,
      status: 'UNSENT',
    });
    expect(unsent.body.data.unsentAt).toEqual(expect.any(String));

    const history = (await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(avery.token))).body.data
      .items;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('UNSENT');
    expect(history[0].text).toBe('');

    const again = await request(app).post(`/api/v1/messages/${message.id}/unsend`).set(bearer(alex.token));
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(message.id);

    expect((await request(app).get('/api/v1/conversations').set(bearer(avery.token))).body.data.items[0].unreadCount).toBe(0);
  });
});

describe('chat photos', () => {
  useTestDatabase();
  let alex;
  let avery;
  let match;

  beforeEach(async () => {
    alex = await createMember({ profile: { displayName: 'Alex' } });
    avery = await createMember({ profile: { displayName: 'Avery' } });
    match = await matchMembers(app, alex, avery);
  });

  it('sends a photo without text and returns a signed URL', async () => {
    const photo = await uploadImage(alex);
    const res = await sendMessageBody(alex, match.conversationId, { attachmentMediaId: photo.id, clientMessageId: uuidv4() });

    expect(res.status).toBe(201);
    expect(res.body.data.text).toBe('');
    expect(res.body.data.attachment).toEqual({
      mediaId: photo.id,
      url: expect.stringMatching(/\/uploads\/chat\/.+\?expires=\d+&signature=/),
      contentType: 'image/jpeg',
      width: 64,
      height: 48,
    });

    const signedUrl = new URL(res.body.data.attachment.url);
    expect((await request(app).get(signedUrl.pathname + signedUrl.search)).status).toBe(200);
  });

  it('sends a photo with a caption and shows it in the history and conversation list', async () => {
    const photo = await uploadImage(alex);
    await sendMessageBody(alex, match.conversationId, { text: ' Look! ', attachmentMediaId: photo.id, clientMessageId: uuidv4() });

    const history = (await request(app).get(`/api/v1/conversations/${match.conversationId}/messages`).set(bearer(avery.token))).body.data.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ text: 'Look!', attachment: { mediaId: photo.id } });

    const list = (await request(app).get('/api/v1/conversations').set(bearer(avery.token))).body.data.items;
    expect(list[0].lastMessage.attachment.mediaId).toBe(photo.id);
  });

  it('lets only the conversation partner read the photo metadata', async () => {
    const photo = await uploadImage(alex);
    const otherMatch = await createMember();
    await matchMembers(app, alex, otherMatch);

    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(avery.token))).status).toBe(404);
    await sendMessageBody(alex, match.conversationId, { attachmentMediaId: photo.id, clientMessageId: uuidv4() });

    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(avery.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(otherMatch.token))).status).toBe(404);

    await request(app).post(`/api/v1/matches/${match.id}/unmatch`).set(bearer(avery.token));
    expect((await request(app).get(`/api/v1/media/${photo.id}`).set(bearer(avery.token))).status).toBe(404);
  });

  it('rejects someone else\'s media, profile photos and unknown ids', async () => {
    const averysPhoto = await uploadImage(avery);
    const profilePhoto = await uploadImage(alex, 'PROFILE_PHOTO');

    for (const attachmentMediaId of [averysPhoto.id, profilePhoto.id, 'med_000000000000000000000000']) {
      const res = await sendMessageBody(alex, match.conversationId, { attachmentMediaId, clientMessageId: uuidv4() });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'attachmentMediaId', reason: 'UNKNOWN_MEDIA' }]);
    }
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects a message with neither text nor photo, and a non-string media id', async () => {
    const empty = await sendMessageBody(alex, match.conversationId, { text: '  ', clientMessageId: uuidv4() });
    expect(empty.body.error.details).toEqual([{ field: 'text', reason: 'LENGTH_1_1000' }]);

    const wrongType = await sendMessageBody(alex, match.conversationId, { text: 'Hi', attachmentMediaId: 42, clientMessageId: uuidv4() });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.details).toEqual([{ field: 'attachmentMediaId', reason: 'INVALID_FORMAT' }]);
  });

  it('returns the same photo message for a retried send', async () => {
    const photo = await uploadImage(alex);
    const body = { attachmentMediaId: photo.id, clientMessageId: uuidv4() };
    const first = await sendMessageBody(alex, match.conversationId, body);
    const retry = await sendMessageBody(alex, match.conversationId, body);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await Message.countDocuments()).toBe(1);
  });
});

describe('message rate limit per user', () => {
  useTestDatabase();

  it('limits a member to 300 messages per hour across conversations', async () => {
    const sender = await createMember();
    const conversations = [];
    for (let index = 0; index < 11; index += 1) {
      conversations.push((await matchMembers(app, sender, await createMember())).conversationId);
    }

    let sent = 0;
    for (const conversationId of conversations.slice(0, 10)) {
      const batch = await Promise.all(Array.from({ length: 30 }, (_, index) => sendMessage(sender, conversationId, `m${index}`)));
      sent += batch.filter((res) => res.status === 201).length;
    }
    expect(sent).toBe(300);
    expect((await sendMessage(sender, conversations[10], 'over the hourly limit')).status).toBe(429);
  });
});
