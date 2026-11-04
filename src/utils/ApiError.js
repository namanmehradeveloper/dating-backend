// Defines ApiError, the only kind of error whose code, message and details are sent to clients.
// Codes and HTTP statuses follow docs/api/error_codes.md exactly.

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  ACCOUNT_INELIGIBLE: 403,
  USER_BLOCKED: 403,
  MATCH_REQUIRED: 403,
  SUBSCRIPTION_REQUIRED: 403,
  MEDIA_REJECTED: 422,
  SERVER_ERROR: 500,
  FEATURE_NOT_CONFIGURED: 501,
});

const DEFAULT_MESSAGES = Object.freeze({
  VALIDATION_ERROR: 'Please correct the highlighted fields.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'This is no longer available.',
  CONFLICT: 'This action has already been done.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  OTP_INVALID: 'That code is incorrect.',
  OTP_EXPIRED: 'That code has expired. Please request a new one.',
  ACCOUNT_INELIGIBLE: 'This account is not eligible to use Dating Cloud.',
  USER_BLOCKED: 'You have blocked this member.',
  MATCH_REQUIRED: 'You are no longer matched with this member.',
  SUBSCRIPTION_REQUIRED: 'Upgrade your plan to use this feature.',
  MEDIA_REJECTED: 'This photo could not be used. Please choose a different one.',
  SERVER_ERROR: 'Something went wrong. Please try again.',
  FEATURE_NOT_CONFIGURED: 'This feature is not available yet.',
});

// An error that is safe to show to users. `message` and `details` must never contain internals.
// Usage: throw new ApiError('OTP_INVALID') or throw new ApiError('SUBSCRIPTION_REQUIRED', { details }).
export class ApiError extends Error {
  constructor(code, { message, details = [], statusCode, retryAfterSeconds } = {}) {
    if (!(code in ERROR_CODES)) throw new TypeError(`Unknown error code: ${code}`);
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode ?? ERROR_CODES[code];
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  // 400 VALIDATION_ERROR with per-field details such as { field: 'displayName', reason: 'REQUIRED' }.
  static validation(details = [], message) {
    return new ApiError('VALIDATION_ERROR', { details, message });
  }

  // 401 UNAUTHENTICATED for a missing, invalid or expired access token.
  static unauthenticated(message) {
    return new ApiError('UNAUTHENTICATED', { message });
  }

  // 403 FORBIDDEN when the signed-in user is not allowed to do this (for example a wrong role).
  static forbidden(message) {
    return new ApiError('FORBIDDEN', { message });
  }

  // 404 NOT_FOUND, also used to hide resources the user must not know exist.
  static notFound(message) {
    return new ApiError('NOT_FOUND', { message });
  }

  // 409 CONFLICT for duplicate actions or an idempotency key reused with a different body.
  static conflict(message, details) {
    return new ApiError('CONFLICT', { message, details });
  }

  // 429 RATE_LIMITED; the error handler turns retryAfterSeconds into a Retry-After header.
  static rateLimited(retryAfterSeconds, message) {
    return new ApiError('RATE_LIMITED', { message, retryAfterSeconds });
  }

  // 500 SERVER_ERROR with a generic message; the real cause is only logged on the server.
  static server(message) {
    return new ApiError('SERVER_ERROR', { message });
  }
}
