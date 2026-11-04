// Managing photos after onboarding (add, reorder, delete) and submitting a selfie for verification.

import { Media } from '../models/Media.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { VerificationRequest } from '../models/VerificationRequest.js';
import { ApiError } from '../utils/ApiError.js';
import { deleteMedia } from './media.service.js';
import { getMyProfile } from './profile.service.js';

export const MAX_PHOTOS = 6;

// Loads the member's profile, or 409 when onboarding is not finished.
async function loadProfile(userId) {
  const profile = await Profile.findOne({ userId });
  if (!profile) throw ApiError.conflict('Please finish setting up your profile first.');
  return profile;
}

// Loads one of the member's own uploads with the expected purpose. Rejected uploads give MEDIA_REJECTED.
async function loadOwnMedia(userId, mediaId, purpose, field) {
  const media = await Media.findOne({ _id: mediaId, ownerId: userId, purpose, status: { $ne: 'DELETED' } });
  if (!media) throw ApiError.validation([{ field, reason: 'UNKNOWN_MEDIA' }]);
  if (media.status === 'REJECTED') throw new ApiError('MEDIA_REJECTED', { details: [{ field, reason: 'REJECTED' }] });
  return media;
}

// Attaches an uploaded photo to the end of the profile (maximum six photos).
export async function addPhoto(userId, mediaId) {
  const profile = await loadProfile(userId);
  const media = await loadOwnMedia(userId, mediaId, 'PROFILE_PHOTO', 'mediaId');

  if (profile.photos.some((photo) => photo.mediaId === mediaId)) {
    throw ApiError.conflict('This photo is already on your profile.');
  }

  // The filter makes the "maximum six" check and the insert one atomic step.
  const result = await Profile.updateOne(
    { userId, [`photos.${MAX_PHOTOS - 1}`]: { $exists: false }, 'photos.mediaId': { $ne: mediaId } },
    {
      $push: {
        photos: {
          mediaId,
          relativePath: media.relativePath,
          order: profile.photos.length,
          moderationStatus: 'PENDING',
        },
      },
    },
  );
  if (result.modifiedCount === 0) throw ApiError.conflict('You already have the maximum number of photos.');

  return getMyProfile(userId);
}

// Puts the photos in the given order. The list must contain exactly the current photo ids.
export async function reorderPhotos(userId, photoIds) {
  const profile = await loadProfile(userId);
  const currentIds = profile.photos.map((photo) => photo._id).sort();
  const isSameSet = currentIds.length === photoIds.length && [...photoIds].sort().every((id, index) => id === currentIds[index]);
  if (!isSameSet) throw ApiError.validation([{ field: 'photoIds', reason: 'INVALID' }]);

  for (const photo of profile.photos) {
    photo.order = photoIds.indexOf(photo._id);
  }
  await profile.save();
  return getMyProfile(userId);
}

// Removes a photo from the profile and deletes its file. At least one photo must remain.
export async function deletePhoto(userId, photoId) {
  const profile = await loadProfile(userId);
  const photo = profile.photos.find((item) => item._id === photoId);
  if (!photo) throw ApiError.notFound();
  if (profile.photos.length <= 1) throw ApiError.conflict('Your profile needs at least one photo.');

  profile.photos = profile.photos
    .filter((item) => item._id !== photoId)
    .sort((a, b) => a.order - b.order)
    .map((item, order) => Object.assign(item, { order }));
  await profile.save();

  const media = await Media.findById(photo.mediaId);
  if (media) await deleteMedia(media);
  return getMyProfile(userId);
}

// Submits a selfie for review. Only one request can be pending, and verified members cannot resubmit.
export async function submitVerification(userId, selfieMediaId) {
  await loadProfile(userId);
  await loadOwnMedia(userId, selfieMediaId, 'VERIFICATION_SELFIE', 'selfieMediaId');

  const user = await User.findById(userId);
  if (user.verificationStatus === 'VERIFIED') throw ApiError.conflict('You are already verified.');
  if (await VerificationRequest.exists({ userId, status: 'PENDING' })) {
    throw ApiError.conflict('Your verification is already being reviewed.');
  }

  const request = await VerificationRequest.create({ userId, selfieMediaId });
  await User.updateOne({ _id: userId }, { $set: { verificationStatus: 'PENDING' } });
  return { status: 'PENDING', submittedAt: request.createdAt };
}
