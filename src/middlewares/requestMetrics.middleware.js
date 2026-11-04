// Records per-request latency and status codes into the in-process metrics service.

import { recordRequest } from '../services/metrics.service.js';

export function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const path = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : (req.originalUrl || req.url || '/').split('?')[0];
    recordRequest({
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs,
      errorCode: res.locals?.errorCode,
      errorMessage: res.locals?.errorMessage,
    });
  });
  next();
}
