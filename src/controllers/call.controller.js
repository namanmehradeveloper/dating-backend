import { ApiResponse } from '../utils/ApiResponse.js';
import * as callService from '../services/call.service.js';
import { CALL_TYPES } from '../models/Call.js';
import { ApiError } from '../utils/ApiError.js';

function validateStartCall(body) {
  const details = [];
  if (typeof body?.conversationId !== 'string' || !body.conversationId.trim()) {
    details.push({ field: 'conversationId', reason: 'REQUIRED' });
  }
  if (!CALL_TYPES.includes(body?.type)) details.push({ field: 'type', reason: 'INVALID' });
  if (details.length) throw ApiError.validation(details);
  return { conversationId: body.conversationId.trim(), type: body.type };
}

function historyLimit(value) {
  if (value === undefined) return 20;
  if (!/^\d+$/.test(String(value))) throw ApiError.validation([{ field: 'limit', reason: 'INVALID' }]);
  return Math.min(Math.max(Number(value), 1), 50);
}

export async function start(req, res) {
  return ApiResponse.created(res, await callService.startCall(req.user.id, validateStartCall(req.body)));
}

export async function active(req, res) {
  return ApiResponse.ok(res, await callService.getActiveCall(req.user.id));
}

export async function history(req, res) {
  return ApiResponse.ok(res, await callService.listCallHistory(req.user.id, historyLimit(req.query.limit)));
}

export async function accept(req, res) {
  return ApiResponse.ok(res, await callService.acceptCall(req.user.id, req.params.callId));
}

export async function reject(req, res) {
  return ApiResponse.ok(res, await callService.rejectCall(req.user.id, req.params.callId));
}

export async function cancel(req, res) {
  return ApiResponse.ok(res, await callService.cancelCall(req.user.id, req.params.callId));
}

export async function end(req, res) {
  return ApiResponse.ok(res, await callService.endCall(req.user.id, req.params.callId));
}
