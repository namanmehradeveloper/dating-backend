// Handles unknown routes (404) and turns every thrown error into the documented error envelope.
// Stack traces, MongoDB messages and other internals are logged but never sent to clients.

import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { logger } from '../utils/logger.js';

// express.json() error types and the validation detail each one becomes.
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': { field: 'body', reason: 'INVALID_JSON' },
  'entity.too.large': { field: 'body', reason: 'PAYLOAD_TOO_LARGE' },
  'encoding.unsupported': { field: 'body', reason: 'UNSUPPORTED_ENCODING' },
  'charset.unsupported': { field: 'body', reason: 'UNSUPPORTED_ENCODING' },
};

// Mongoose validator kinds and the documented details.reason for each.
const MONGOOSE_VALIDATOR_REASONS = {
  required: 'REQUIRED',
  enum: 'INVALID',
  min: 'OUT_OF_RANGE',
  max: 'OUT_OF_RANGE',
  minlength: 'INVALID_LENGTH',
  maxlength: 'INVALID_LENGTH',
  regexp: 'INVALID_FORMAT',
};

// Sends 404 NOT_FOUND for any route that no router handled.
export function notFound(req, res, next) {
  next(ApiError.notFound('The requested resource was not found.'));
}

function attachErrorLocals(res, err) {
  res.locals.errorCode = err?.code;
  res.locals.errorMessage = err?.message;
}

// Converts a malformed or oversized JSON body error into VALIDATION_ERROR.
function fromBodyParserError(err) {
  const detail = BODY_PARSER_ERRORS[err.type];
  const message = err.type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : undefined;
  return ApiError.validation([detail], message);
}

// Converts a Mongoose schema validation error into VALIDATION_ERROR with one detail per field.
function fromMongooseValidationError(err) {
  const details = Object.values(err.errors).map((fieldError) => {
    if (fieldError instanceof mongoose.Error.CastError) {
      return { field: fieldError.path, reason: 'INVALID_FORMAT' };
    }
    return { field: fieldError.path, reason: MONGOOSE_VALIDATOR_REASONS[fieldError.kind] ?? 'INVALID' };
  });
  return ApiError.validation(details);
}

// Maps known error types to a client-safe ApiError. Returns null for unexpected errors.
export function toApiError(err) {
  if (err instanceof ApiError) return err;

  if (err?.type && BODY_PARSER_ERRORS[err.type]) return fromBodyParserError(err);

  if (err instanceof mongoose.Error.ValidationError) return fromMongooseValidationError(err);

  // A malformed id can never match a document, so it is reported like a missing one.
  if (err instanceof mongoose.Error.CastError) return ApiError.notFound();

  // Duplicate key: the record already exists. The key itself is not revealed.
  if (err?.code === 11000) return ApiError.conflict();

  return null;
}

// Express error handler (must stay the last middleware). Unexpected errors are logged with
// their stack and returned as a generic 500 SERVER_ERROR.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let apiError = toApiError(err);

  if (!apiError) {
    logger.error('Unhandled error', {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.originalUrl,
      error: err?.message,
      stack: err?.stack,
    });
    apiError = ApiError.server();
  } else if (apiError.statusCode >= 500) {
    logger.error(apiError.message, { requestId: res.locals.requestId, code: apiError.code });
  }

  if (apiError.retryAfterSeconds) {
    res.setHeader('Retry-After', String(Math.ceil(apiError.retryAfterSeconds)));
  }
  attachErrorLocals(res, apiError);
  return ApiResponse.error(res, apiError);
}
