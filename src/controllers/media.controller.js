// HTTP handlers for /media and the profile photo / verification endpoints.

import { ApiResponse } from '../utils/ApiResponse.js';
import { getMediaForViewer, saveUploadedImage } from '../services/media.service.js';
import * as profilePhotos from '../services/profilePhotos.service.js';
import {
  validateAddPhoto,
  validatePhotoOrder,
  validateUpload,
  validateVerificationRequest,
} from '../validators/media.validator.js';

// POST /media/upload — saves an image locally and returns its mediaId and URL.
export async function uploadMedia(req, res) {
  const { purpose } = validateUpload(req.body, req.file);
  const media = await saveUploadedImage(req.user.id, purpose, req.file);
  return ApiResponse.created(res, media);
}

// GET /media/:mediaId — media metadata for the owner or another authorised member.
export async function getMedia(req, res) {
  return ApiResponse.ok(res, await getMediaForViewer(req.user.id, req.params.mediaId));
}

// POST /profile/photos — attaches an uploaded photo.
export async function addPhoto(req, res) {
  const { mediaId } = validateAddPhoto(req.body);
  return ApiResponse.created(res, await profilePhotos.addPhoto(req.user.id, mediaId));
}

// PATCH /profile/photos/order — reorders photos.
export async function reorderPhotos(req, res) {
  const { photoIds } = validatePhotoOrder(req.body);
  return ApiResponse.ok(res, await profilePhotos.reorderPhotos(req.user.id, photoIds));
}

// DELETE /profile/photos/:photoId — removes a photo and its file.
export async function deletePhoto(req, res) {
  return ApiResponse.ok(res, await profilePhotos.deletePhoto(req.user.id, req.params.photoId));
}

// POST /profile/verification — submits a selfie for review.
export async function submitVerification(req, res) {
  const { selfieMediaId } = validateVerificationRequest(req.body);
  return ApiResponse.accepted(res, await profilePhotos.submitVerification(req.user.id, selfieMediaId));
}
