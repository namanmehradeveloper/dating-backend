// Image storage. Uploads are checked and re-encoded with Sharp (which drops EXIF and GPS data),
// then stored on Cloudinary when configured, otherwise written to backend/uploads/<folder>/.
// MongoDB stores the URL (or local relative path) and optional Cloudinary publicId — never the image bytes.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { destroyCloudinaryImage, isCloudinaryEnabled, uploadImageBuffer } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { Conversation } from '../models/Conversation.js';
import { Media } from '../models/Media.js';
import { Message } from '../models/Message.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildFileUrl } from '../utils/fileUrls.js';
import { logger } from '../utils/logger.js';
import { isVisibleMember } from './accountStatus.service.js';
import { isBlockedEitherWay } from './block.service.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 2048;
export const UPLOAD_FOLDERS = ['profile', 'verification', 'chat', 'temp'];

const FOLDER_BY_PURPOSE = {
  PROFILE_PHOTO: 'profile',
  VERIFICATION_SELFIE: 'verification',
  CHAT_ATTACHMENT: 'chat',
};

// Image formats we accept, detected from the file bytes (never from the name or client MIME type).
const SUPPORTED_FORMATS = {
  jpeg: { extension: 'jpg', contentType: 'image/jpeg', options: { quality: 85, mozjpeg: true } },
  png: { extension: 'png', contentType: 'image/png', options: { compressionLevel: 9 } },
  webp: { extension: 'webp', contentType: 'image/webp', options: { quality: 85 } },
};

// Creates backend/uploads and its sub-folders if they do not exist yet (local / test fallback).
export async function ensureUploadFolders() {
  await Promise.all(UPLOAD_FOLDERS.map((folder) => fs.mkdir(path.join(env.uploadsDir, folder), { recursive: true })));
}

// Builds a 422 MEDIA_REJECTED error with the documented reason (UNSUPPORTED_TYPE, TOO_LARGE).
export function mediaRejected(reason) {
  return new ApiError('MEDIA_REJECTED', { details: [{ field: 'file', reason }] });
}

// Reads the real image format with Sharp. Anything that is not a valid JPEG, PNG or WebP is rejected.
async function detectImageFormat(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    const format = SUPPORTED_FORMATS[metadata.format];
    if (!format) throw mediaRejected('UNSUPPORTED_TYPE');
    return { ...format, name: metadata.format };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw mediaRejected('UNSUPPORTED_TYPE');
  }
}

// Re-encodes the image: applies the camera rotation, limits the size to 2048 px and strips all metadata.
async function processImage(buffer, format) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .toFormat(format.name, format.options)
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw mediaRejected('UNSUPPORTED_TYPE');
  }
}

// Generates a safe file name such as usr_abc_1720000000000_a82c91.jpg.
function generateFileName(userId, extension) {
  return `${userId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${extension}`;
}

// Writes the file to uploads/temp first, then moves it into place so a half-written file is never served.
async function writeFileSafely(folder, fileName, data) {
  await ensureUploadFolders();
  const tempPath = path.join(env.uploadsDir, 'temp', fileName);
  const finalPath = path.join(env.uploadsDir, folder, fileName);
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, finalPath);
}

// Shapes a Media record for the API. The URL is absolute; private local files get a signed URL.
export function presentMedia(media) {
  return {
    id: media._id,
    mediaId: media._id,
    purpose: media.purpose,
    status: media.status,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    width: media.width ?? null,
    height: media.height ?? null,
    url: buildFileUrl(media.relativePath),
    createdAt: media.createdAt,
  };
}

// Validates, processes and saves an uploaded image, then creates its Media record.
export async function saveUploadedImage(userId, purpose, file) {
  if (file.size > MAX_UPLOAD_BYTES) throw mediaRejected('TOO_LARGE');

  const format = await detectImageFormat(file.buffer);
  const { data, info } = await processImage(file.buffer, format);

  const folder = FOLDER_BY_PURPOSE[purpose];
  const fileName = generateFileName(userId, format.extension);

  let relativePath;
  let publicId;
  let sizeBytes = info.size;
  let width = info.width;
  let height = info.height;

  if (isCloudinaryEnabled()) {
    try {
      const uploaded = await uploadImageBuffer(data, {
        folder,
        fileName,
        contentType: format.contentType,
      });
      relativePath = uploaded.secureUrl;
      publicId = uploaded.publicId;
      sizeBytes = uploaded.bytes ?? sizeBytes;
      width = uploaded.width ?? width;
      height = uploaded.height ?? height;
    } catch (error) {
      logger.error('Cloudinary upload failed', { err: error });
      throw ApiError.server('Image upload failed. Please try again.');
    }
  } else {
    await writeFileSafely(folder, fileName, data);
    relativePath = `/uploads/${folder}/${fileName}`;
  }

  const media = await Media.create({
    ownerId: userId,
    purpose,
    status: 'APPROVED',
    contentType: format.contentType,
    sizeBytes,
    width,
    height,
    relativePath,
    ...(publicId ? { publicId } : {}),
  });
  return presentMedia(media);
}

// Returns true when someone other than the owner may see this media: profile photos on a visible
// profile, or chat photos sent in an active conversation the viewer is part of. Blocks always hide.
async function canViewOthersMedia(viewerId, media) {
  if (await isBlockedEitherWay(viewerId, media.ownerId)) return false;

  if (media.purpose === 'PROFILE_PHOTO') {
    const [owner, profile] = await Promise.all([
      User.findById(media.ownerId),
      Profile.exists({ userId: media.ownerId, 'photos.mediaId': media._id }),
    ]);
    return Boolean(profile) && isVisibleMember(owner);
  }

  if (media.purpose === 'CHAT_ATTACHMENT') {
    const conversationIds = await Message.distinct('conversationId', { senderId: media.ownerId, 'attachment.mediaId': media._id });
    if (conversationIds.length === 0) return false;
    const sharedConversation = await Conversation.exists({ _id: { $in: conversationIds }, participantIds: viewerId, status: 'ACTIVE' });
    return Boolean(sharedConversation);
  }
  return false;
}

// Returns media metadata to an authorised caller; everyone else gets 404.
export async function getMediaForViewer(viewerId, mediaId) {
  const media = await Media.findById(mediaId);
  if (!media || media.status === 'DELETED') throw ApiError.notFound();

  const isOwner = media.ownerId === viewerId;
  if (!isOwner && !(await canViewOthersMedia(viewerId, media))) throw ApiError.notFound();
  return presentMedia(media);
}

// Removes the stored file (Cloudinary or local disk). A missing file is not an error.
export async function removeMediaFile(media) {
  if (media.publicId) {
    try {
      await destroyCloudinaryImage(media.publicId);
    } catch (error) {
      logger.warn('Cloudinary destroy failed', { publicId: media.publicId, err: error });
    }
    return;
  }

  if (media.relativePath && media.relativePath.startsWith('/uploads/')) {
    await fs.rm(getAbsoluteFilePath(media.relativePath), { force: true });
  }
}

// Removes a media file and marks its record DELETED.
export async function deleteMedia(media) {
  await removeMediaFile(media);
  await Media.updateOne({ _id: media._id }, { $set: { status: 'DELETED', deletedAt: new Date() } });
}

// Returns the absolute disk path of a locally stored file (used by tests and the deletion job).
export function getAbsoluteFilePath(relativePath) {
  return path.join(env.uploadsDir, relativePath.replace(/^\/uploads\//, ''));
}
