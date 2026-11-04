// Validates support tickets and account deletion requests.

import { TICKET_CATEGORIES } from '../models/SupportTicket.js';
import { checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';

// POST /support/tickets: { category, subject (3–120), message (10–5000) }.
export function validateTicket(body) {
  requireObjectBody(body);
  const details = [];
  const ticket = {
    category: checkEnum(details, 'category', body.category, TICKET_CATEGORIES),
    subject: checkText(details, 'subject', body.subject, { min: 3, max: 120, reason: 'LENGTH_3_120' }),
    message: checkText(details, 'message', body.message, { min: 10, max: 5000, reason: 'LENGTH_10_5000' }),
  };
  throwIfInvalid(details);
  return ticket;
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
