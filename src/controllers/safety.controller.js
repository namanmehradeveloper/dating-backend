// HTTP handlers for blocks and reports.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as safetyService from '../services/safety.service.js';
import { validateMessageReport, validateReport } from '../validators/safety.validator.js';

// POST /users/:userId/block — block a member (idempotent).
export async function blockUser(req, res) {
  await safetyService.blockUser(req.user.id, req.params.userId);
  return ApiResponse.ok(res, null);
}

// DELETE /users/:userId/block — unblock a member.
export async function unblockUser(req, res) {
  await safetyService.unblockUser(req.user.id, req.params.userId);
  return ApiResponse.ok(res, null);
}

// GET /blocks — members you blocked.
export async function listBlocks(req, res) {
  return ApiResponse.ok(res, await safetyService.listBlocks(req.user.id, parsePagination(req.query)));
}

// POST /reports — report a member or photo.
export async function createReport(req, res) {
  const input = validateReport(req.body);
  return ApiResponse.created(res, await safetyService.reportUserOrPhoto(req.user.id, input));
}

// POST /messages/:messageId/report — report a received message.
export async function reportMessage(req, res) {
  const input = validateMessageReport(req.body);
  return ApiResponse.created(res, await safetyService.reportMessage(req.user.id, req.params.messageId, input));
}
