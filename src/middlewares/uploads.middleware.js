// Serves uploaded files from backend/uploads at /uploads.
// Profile photos are public; verification selfies and chat files need a signed URL (see utils/fileUrls.js).
// Temporary files are never served.

import express from 'express';
import { env } from '../config/env.js';
import { isPrivateUploadPath, isValidFileSignature } from '../utils/fileUrls.js';
import { ApiError } from '../utils/ApiError.js';

const SERVED_FOLDERS = ['profile', 'verification', 'chat'];

// Lets the admin panel (another origin) show images in <img> tags; Helmet blocks this by default.
function allowCrossOriginImages(req, res, next) {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}

// Rejects requests for unknown folders and private files without a valid signature with 404.
function checkFileAccess(req, res, next) {
  const relativePath = `/uploads${req.path}`;
  const folder = req.path.split('/')[1];

  if (!SERVED_FOLDERS.includes(folder)) return next(ApiError.notFound());

  if (isPrivateUploadPath(relativePath)) {
    const { expires, signature } = req.query;
    if (!isValidFileSignature(relativePath, expires, signature)) return next(ApiError.notFound());
  }
  next();
}

// Returns the router mounted at /uploads in app.js.
export function uploadsRouter() {
  const router = express.Router();
  router.use(allowCrossOriginImages);
  router.use(checkFileAccess);
  router.use(express.static(env.uploadsDir, { index: false, dotfiles: 'deny', fallthrough: true, maxAge: '1h' }));
  return router;
}
