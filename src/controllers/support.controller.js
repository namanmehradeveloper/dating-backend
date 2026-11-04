// HTTP handlers for FAQs, support tickets, account deletion and data export status.

import { ApiResponse } from '../utils/ApiResponse.js';
import * as accountService from '../services/account.service.js';
import * as supportService from '../services/support.service.js';
import { validateDeletionRequest, validateTicket } from '../validators/support.validator.js';

// GET /support/faqs — public.
export async function getFaqs(req, res) {
  return ApiResponse.ok(res, { items: supportService.listFaqs() });
}

// POST /support/tickets — open a ticket.
export async function createTicket(req, res) {
  const ticket = validateTicket(req.body);
  return ApiResponse.created(res, await supportService.createTicket(req.user.id, ticket));
}

// GET /support/tickets/:ticketId — one of your tickets.
export async function getTicket(req, res) {
  return ApiResponse.ok(res, await supportService.getTicket(req.user.id, req.params.ticketId));
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
