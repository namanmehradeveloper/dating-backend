// Receives multipart image file(s) into memory with Multer, limited to 10 MB each.
// The bytes are only trusted after Sharp has checked them in media.service.js.

import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';
import { MAX_UPLOAD_BYTES, mediaRejected } from '../services/media.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 6, fields: 5, fieldSize: 1024 },
});

const receiveSingleFile = upload.single('file');
const receiveManyFiles = upload.array('files', 6);

// Converts Multer errors into the documented API errors (TOO_LARGE, or a validation error).
function toUploadError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return mediaRejected('TOO_LARGE');
    if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
      return ApiError.validation([{ field: 'files', reason: 'COUNT_1_6' }]);
    }
    return ApiError.validation([{ field: error.field || 'file', reason: 'INVALID' }]);
  }
  return ApiError.validation([{ field: 'body', reason: 'INVALID_MULTIPART' }]);
}

// Runs Multer and passes any upload problem to the error handler as an ApiError.
export function receiveImageUpload(req, res, next) {
  receiveSingleFile(req, res, (error) => {
    if (error) return next(toUploadError(error));
    next();
  });
}

// Accepts 1–6 files under the multipart field name "files".
export function receiveImageUploads(req, res, next) {
  receiveManyFiles(req, res, (error) => {
    if (error) return next(toUploadError(error));
    next();
  });
}
