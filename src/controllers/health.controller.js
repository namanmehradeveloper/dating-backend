// Health check used by developers and monitoring to confirm the API and MongoDB are up.

import { env } from '../config/env.js';
import { getDbState } from '../config/db.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';

// Returns 200 with server status when MongoDB is connected, otherwise 503 with the database state.
export function getHealth(req, res) {
  const database = getDbState();

  if (database !== 'connected') {
    throw new ApiError('SERVER_ERROR', {
      statusCode: 503,
      message: 'The service is temporarily unavailable.',
      details: [{ field: 'database', reason: database.toUpperCase() }],
    });
  }

  return ApiResponse.ok(res, {
    status: 'ok',
    database,
    environment: env.nodeEnv,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
