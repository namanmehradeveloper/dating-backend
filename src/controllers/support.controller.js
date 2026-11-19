// HTTP handlers for FAQs, support tickets, account deletion and data export status.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as accountService from '../services/account.service.js';
import * as supportService from '../services/support.service.js';
import { validateDeletionRequest, validateTicket, validateTicketReply } from '../validators/support.validator.js';

// GET /support/faqs — public.
export async function getFaqs(req, res) {
  return ApiResponse.ok(res, { items: supportService.listFaqs() });
}

// POST /support/tickets — open a ticket (authenticated or guest).
export async function createTicket(req, res) {
  const isGuest = !req.user?.id;
  const ticket = validateTicket(req.body, { isGuest });
  return ApiResponse.created(res, await supportService.createTicket(req.user?.id ?? null, ticket));
}

// GET /support/tickets — authenticated member's own tickets.
export async function listTickets(req, res) {
  return ApiResponse.ok(res, await supportService.listTickets(req.user.id, parsePagination(req.query)));
}

// GET /support/tickets/:ticketId — one of your tickets.
export async function getTicket(req, res) {
  return ApiResponse.ok(res, await supportService.getTicket(req.user.id, req.params.ticketId));
}

// POST /support/tickets/:ticketId/messages — owner follow-up reply.
export async function replyToTicket(req, res) {
  const reply = validateTicketReply(req.body);
  return ApiResponse.created(res, await supportService.replyToTicket(req.user.id, req.params.ticketId, reply));
}

// POST /account/deletion-request — schedule account deletion (202).
export async function requestDeletion(req, res) {
  const request = validateDeletionRequest(req.body);
  return ApiResponse.accepted(res, await accountService.requestDeletion(req.user.id, request));
}

// GET /account/export-status
export async function getExportStatus(req, res) {
  return ApiResponse.ok(res, accountService.getExportStatus());
}
