// Builds the URLs clients use to load uploaded files from backend/uploads.
// Profile photos are public. Verification selfies and chat files get a short-lived URL signed with
// an HMAC of the path and expiry, checked by uploads.middleware.js before the file is served.

import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const SIGNED_URL_TTL_SECONDS = 3600;
const PRIVATE_FOLDERS = ['verification', 'chat'];

// Returns true when files in this /uploads/<folder>/ path need a signed URL.
export function isPrivateUploadPath(relativePath) {
  const folder = relativePath.split('/')[2];
  return PRIVATE_FOLDERS.includes(folder);
}

// Computes the signature for a relative path such as /uploads/chat/file.jpg and its expiry time.
function computeSignature(relativePath, expiresAt) {
  return crypto
    .createHmac('sha256', env.jwtAccessSecret)
    .update(`${relativePath}:${expiresAt}`)
    .digest('base64url');
}

// Turns a stored path into the URL returned to clients.
// Cloudinary (https) URLs are returned as-is. Local private files get a 1-hour signed URL.
export function buildFileUrl(relativePath) {
  if (!relativePath) return null;
  if (/^https?:\/\//i.test(relativePath)) return relativePath;

  const absoluteUrl = `${env.appUrl}${relativePath}`;
  if (!isPrivateUploadPath(relativePath)) return absoluteUrl;

  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
  const signature = computeSignature(relativePath, expiresAt);
  return `${absoluteUrl}?expires=${expiresAt}&signature=${signature}`;
}

// Checks the expiry and signature of a private file request. Returns true only for a valid, unexpired URL.
export function isValidFileSignature(relativePath, expires, signature) {
  const expiresAt = Number(expires);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  if (typeof signature !== 'string') return false;

  const expected = Buffer.from(computeSignature(relativePath, expiresAt));
  const received = Buffer.from(signature);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
