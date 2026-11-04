// Validates media uploads and the profile photo / verification requests that reference media.

import { MEDIA_PURPOSES } from '../models/Media.js';
import { checkEnum, checkText, checkUniqueStringList, requireObjectBody, throwIfInvalid } from './common.js';

// POST /media/upload (multipart): a "file" part and a "purpose" field.
export function validateUpload(body, file) {
  const details = [];
  const purpose = checkEnum(details, 'purpose', body?.purpose, MEDIA_PURPOSES, { reason: 'INVALID' });
  if (!file) details.push({ field: 'file', reason: 'REQUIRED' });
  throwIfInvalid(details);
  return { purpose };
}

// POST /profile/photos: { mediaId }.
export function validateAddPhoto(body) {
  requireObjectBody(body);
  const details = [];
  const mediaId = checkText(details, 'mediaId', body.mediaId, { max: 64, reason: 'INVALID' });
  throwIfInvalid(details);
  return { mediaId };
}

// PATCH /profile/photos/order: { photoIds: [...] } in the new display order.
export function validatePhotoOrder(body) {
  requireObjectBody(body);
  const details = [];
  const photoIds = checkUniqueStringList(details, 'photoIds', body.photoIds, { min: 1, max: 6, reason: 'INVALID' });
  throwIfInvalid(details);
  return { photoIds };
}

// POST /profile/verification: { selfieMediaId }.
export function validateVerificationRequest(body) {
  requireObjectBody(body);
  const details = [];
  const selfieMediaId = checkText(details, 'selfieMediaId', body.selfieMediaId, { max: 64, reason: 'INVALID' });
  throwIfInvalid(details);
  return { selfieMediaId };
}
