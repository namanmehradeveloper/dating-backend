// Validates device registration and notification preference updates.

import { DEVICE_PLATFORMS } from '../models/Device.js';
import { ApiError } from '../utils/ApiError.js';
import { checkBoolean, checkEnum, checkText, requireObjectBody, throwIfInvalid } from './common.js';

const PREFERENCE_FIELDS = ['newMatches', 'messages', 'likes', 'promotions'];

// POST /devices: { platform, pushToken, appVersion?, locale? }.
export function validateDevice(body) {
  requireObjectBody(body);
  const details = [];
  const device = {
    platform: checkEnum(details, 'platform', body.platform, DEVICE_PLATFORMS),
    pushToken: checkText(details, 'pushToken', body.pushToken, { max: 4096, reason: 'INVALID' }),
    appVersion: checkText(details, 'appVersion', body.appVersion, { max: 32, reason: 'INVALID', required: false }),
    locale: checkText(details, 'locale', body.locale, { max: 35, reason: 'INVALID', required: false }),
  };
  throwIfInvalid(details);
  return device;
}

// PATCH /notification-preferences: any subset of the four switches, at least one.
export function validatePreferenceUpdate(body) {
  requireObjectBody(body);
  const details = [];
  const changes = {};
  for (const field of Object.keys(body)) {
    if (!PREFERENCE_FIELDS.includes(field)) {
      details.push({ field, reason: 'UNKNOWN_FIELD' });
      continue;
    }
    changes[field] = checkBoolean(details, field, body[field]);
  }
  throwIfInvalid(details);
  if (Object.keys(changes).length === 0) throw ApiError.validation([{ field: 'body', reason: 'NO_FIELDS' }]);
  return changes;
}
