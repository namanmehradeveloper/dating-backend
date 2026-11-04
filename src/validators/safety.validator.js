// Validates report requests.

import { REPORT_REASONS } from '../models/Report.js';
import { checkBoolean, checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';

// Fields shared by member, photo and message reports: reason, details?, alsoBlock (default true).
function checkReportBasics(details, body) {
  return {
    reason: checkEnum(details, 'reason', body.reason, REPORT_REASONS),
    details: checkText(details, 'details', body.details, { max: 1000, reason: 'MAX_1000', required: false }),
    alsoBlock: checkBoolean(details, 'alsoBlock', body.alsoBlock, { required: false }) ?? true,
  };
}

// POST /reports: { targetType: USER | PHOTO, targetId, reason, details?, alsoBlock? }.
export function validateReport(body) {
  requireObjectBody(body);
  const details = [];
  const input = {
    targetType: checkEnum(details, 'targetType', body.targetType, ['USER', 'PHOTO']),
    targetId: checkText(details, 'targetId', body.targetId, { max: 64, reason: 'INVALID' }),
    ...checkReportBasics(details, body),
  };
  throwIfInvalid(details);
  return input;
}

// POST /messages/:messageId/report: { reason, details?, alsoBlock? }.
export function validateMessageReport(body) {
  requireObjectBody(body);
  const details = [];
  const input = checkReportBasics(details, body);
  throwIfInvalid(details);
  return input;
}
