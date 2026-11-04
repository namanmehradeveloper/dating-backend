// Builds the Express app: security headers, CORS, JSON parsing, uploaded files at /uploads,
// the /api/v1 routes, and the 404 and error handlers. index.js starts it; tests use it with Supertest.

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { requestId } from './middlewares/requestId.middleware.js';
import { requestMetrics } from './middlewares/requestMetrics.middleware.js';
import { errorHandler, notFound } from './middlewares/error.middleware.js';
import { uploadsRouter } from './middlewares/uploads.middleware.js';
import apiRoutes from './routes/index.js';

export const API_PREFIX = '/api/v1';

// CORS settings for the React admin, which calls the API directly from the browser.
// Origins not in the allow-list get no CORS headers, so the browser blocks them.
// Flutter native apps send no Origin header and are not affected.
export function corsOptions(allowedOrigins = env.corsOrigins) {
  return {
    origin(origin, callback) {
      const isAllowed = Boolean(origin) && allowedOrigins.includes(origin);
      callback(null, isAllowed);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  };
}

// Creates a fully configured Express app. Order matters: the request id comes first
// so every response (including errors) carries it, and the error handler comes last.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);

  app.use(requestId);
  app.use(requestMetrics);
  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: env.jsonBodyLimit }));

  app.use('/uploads', uploadsRouter());
  app.use(API_PREFIX, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
