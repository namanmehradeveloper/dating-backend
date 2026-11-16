// Validates chat messages. The Idempotency-Key header must equal clientMessageId.

import { validate as isUuid } from 'uuid';
import { isMissing, requireObjectBody, throwIfInvalid, trimmedText } from './common.js';

// POST /conversations/:id/messages:
// { text?, attachmentMediaId?, giftItemId?, paidEmoji?: { packId, emoji }, clientMessageId }.
// Exactly one content mode: text/attachment, gift, or paid emoji.
export function validateSendMessage(body, idempotencyKey) {
  requireObjectBody(body);
  const details = [];

  const hasAttachment = !isMissing(body.attachmentMediaId);
  if (hasAttachment && typeof body.attachmentMediaId !== 'string') {
    details.push({ field: 'attachmentMediaId', reason: 'INVALID_FORMAT' });
  }

  const hasGift = !isMissing(body.giftItemId);
  if (hasGift && typeof body.giftItemId !== 'string') {
    details.push({ field: 'giftItemId', reason: 'INVALID_FORMAT' });
  }

  let paidEmoji = null;
  const hasPaidEmoji = !isMissing(body.paidEmoji);
  if (hasPaidEmoji) {
    if (typeof body.paidEmoji !== 'object' || body.paidEmoji === null || Array.isArray(body.paidEmoji)) {
      details.push({ field: 'paidEmoji', reason: 'INVALID_FORMAT' });
    } else {
      const packId = trimmedText(body.paidEmoji.packId);
      const emoji = trimmedText(body.paidEmoji.emoji);
      if (!packId) details.push({ field: 'paidEmoji.packId', reason: 'REQUIRED' });
      if (!emoji) details.push({ field: 'paidEmoji.emoji', reason: 'REQUIRED' });
      if (packId && emoji) paidEmoji = { packId, emoji };
    }
  }

  const text = trimmedText(body.text) ?? '';
  const isTextInvalid =
    (body.text !== undefined && body.text !== null && typeof body.text !== 'string') || text.length > 1000;
  if (isTextInvalid) details.push({ field: 'text', reason: 'LENGTH_1_1000' });

  const contentModes = [Boolean(text) || hasAttachment, hasGift, hasPaidEmoji].filter(Boolean).length;
  if (contentModes === 0) {
    details.push({ field: 'text', reason: 'LENGTH_1_1000' });
  } else if (contentModes > 1) {
    details.push({ field: 'body', reason: 'ONE_CONTENT_MODE' });
  }

  if (typeof body.clientMessageId !== 'string' || !isUuid(body.clientMessageId)) {
    details.push({ field: 'clientMessageId', reason: 'INVALID_FORMAT' });
  } else if (idempotencyKey !== body.clientMessageId) {
    details.push({ field: 'Idempotency-Key', reason: 'MUST_MATCH_CLIENT_MESSAGE_ID' });
  }

  throwIfInvalid(details);
  return {
    text,
    attachmentMediaId: hasAttachment ? body.attachmentMediaId : null,
    giftItemId: hasGift ? String(body.giftItemId).trim() : null,
    paidEmoji,
    clientMessageId: body.clientMessageId,
  };
}
