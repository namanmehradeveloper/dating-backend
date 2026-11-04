// Sends responses in the documented envelopes:
//   success: { success: true, data, meta: { requestId } }
//   error:   { success: false, error: { code, message, details }, meta: { requestId } }

// Builds the `meta` block. The request id is set by requestId.middleware.js.
function buildMeta(res) {
  return { requestId: res.locals.requestId };
}

export const ApiResponse = {
  // Sends a success envelope with any HTTP status.
  send(res, statusCode, data = null) {
    return res.status(statusCode).json({ success: true, data, meta: buildMeta(res) });
  },

  // Sends 200 OK with data.
  ok(res, data = null) {
    return ApiResponse.send(res, 200, data);
  },

  // Sends 201 Created with the new resource.
  created(res, data = null) {
    return ApiResponse.send(res, 201, data);
  },

  // Sends 202 Accepted for work that finishes later (for example verification review).
  accepted(res, data = null) {
    return ApiResponse.send(res, 202, data);
  },

  // Sends a paginated list as { items, nextCursor }. nextCursor null means this is the last page.
  paginated(res, { items, nextCursor = null }) {
    return ApiResponse.send(res, 200, { items, nextCursor });
  },

  // Sends an ApiError as the error envelope with its HTTP status.
  error(res, apiError) {
    const body = {
      success: false,
      error: {
        code: apiError.code,
        message: apiError.message,
        details: apiError.details ?? [],
      },
      meta: buildMeta(res),
    };
    return res.status(apiError.statusCode).json(body);
  },
};
