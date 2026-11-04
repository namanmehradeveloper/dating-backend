// Validates chat messages. The Idempotency-Key header must equal clientMessageId.

import { validate as isUuid } from 'uuid';
import { isMissing, requireObjectBody, throwIfInvalid, trimmedText } from './common.js';

// POST /conversations/:id/messages: { text? (≤ 1000 after trimming), attachmentMediaId?, clientMessageId (UUID) }.
// A message needs text (1–1000 characters), an attachment, or both.
export function validateSendMessage(body, idempotencyKey) {
  requireObjectBody(body);
  const details = [];

  const hasAttachment = !isMissing(body.attachmentMediaId);
  if (hasAttachment && typeof body.attachmentMediaId !== 'string') {
    details.push({ field: 'attachmentMediaId', reason: 'INVALID_FORMAT' });
  }

  const text = trimmedText(body.text) ?? '';
  const isTextInvalid = (body.text !== undefined && body.text !== null && typeof body.text !== 'string') || text.length > 1000;
  if (isTextInvalid || (!text && !hasAttachment)) details.push({ field: 'text', reason: 'LENGTH_1_1000' });

  if (typeof body.clientMessageId !== 'string' || !isUuid(body.clientMessageId)) {
    details.push({ field: 'clientMessageId', reason: 'INVALID_FORMAT' });
  } else if (idempotencyKey !== body.clientMessageId) {
    details.push({ field: 'Idempotency-Key', reason: 'MUST_MATCH_CLIENT_MESSAGE_ID' });
  }

  throwIfInvalid(details);
  return { text, attachmentMediaId: hasAttachment ? body.attachmentMediaId : null, clientMessageId: body.clientMessageId };
}
