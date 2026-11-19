// Validates support tickets and account deletion requests.

import { TICKET_CATEGORIES } from '../models/SupportTicket.js';
import {
  checkEmail,
  checkEnum,
  checkText,
  isMissing,
  requireObjectBody,
  throwIfInvalid,
  trimmedText,
} from './common.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Optional email: missing is OK; if present must be valid (lower-cased).
function checkOptionalEmail(details, value, field = 'email') {
  if (isMissing(value)) return undefined;
  const email = trimmedText(value)?.toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    details.push({ field, reason: 'INVALID_FORMAT' });
    return undefined;
  }
  return email;
}

// POST /support/tickets: { category, subject, message, name?, email? }.
// Guests must send name + email. Authenticated clients may omit them for backfill.
export function validateTicket(body, { isGuest = false } = {}) {
  requireObjectBody(body);
  const details = [];
  const ticket = {
    category: checkEnum(details, 'category', body.category, TICKET_CATEGORIES),
    subject: checkText(details, 'subject', body.subject, { min: 3, max: 120, reason: 'LENGTH_3_120' }),
    message: checkText(details, 'message', body.message, { min: 10, max: 5000, reason: 'LENGTH_10_5000' }),
    name: checkText(details, 'name', body.name, {
      min: 1,
      max: 80,
      reason: 'LENGTH_1_80',
      required: isGuest,
    }),
    email: isGuest ? checkEmail(details, body.email) : checkOptionalEmail(details, body.email),
  };
  throwIfInvalid(details);
  return ticket;
}

// POST /support/tickets/:ticketId/messages: { body (1–5000) }.
export function validateTicketReply(body) {
  requireObjectBody(body);
  const details = [];
  const text = checkText(details, 'body', body.body, { max: 5000, reason: 'LENGTH_1_5000' });
  throwIfInvalid(details);
  return { body: text };
}

// POST /account/deletion-request: { confirm: true, reason?, feedback? }.
export function validateDeletionRequest(body) {
  requireObjectBody(body);
  const details = [];
  if (body.confirm !== true) details.push({ field: 'confirm', reason: 'MUST_BE_TRUE' });
  const request = {
    reason: checkText(details, 'reason', body.reason, { max: 100, reason: 'MAX_100', required: false }),
    feedback: checkText(details, 'feedback', body.feedback, { max: 1000, reason: 'MAX_1000', required: false }),
  };
  throwIfInvalid(details);
  return request;
}
