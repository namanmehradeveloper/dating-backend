// In-process API request metrics for admin monitoring. Ring buffer only — no external APM.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_SAMPLES = 5_000;
const MAX_RECENT_ERRORS = 40;

/** @type {{ at: number, method: string, path: string, statusCode: number, durationMs: number }[]} */
const samples = [];
/** @type {{ at: string, method: string, path: string, statusCode: number, code?: string, message?: string }[]} */
const recentErrors = [];

function prune(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && samples[0].at < cutoff) samples.shift();
  while (samples.length > MAX_SAMPLES) samples.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// Records one finished HTTP request (called from request-metrics middleware).
export function recordRequest({ method, path, statusCode, durationMs, errorCode, errorMessage }) {
  const at = Date.now();
  const route = typeof path === 'string' ? path.slice(0, 200) : '/';
  samples.push({
    at,
    method: String(method || 'GET').toUpperCase(),
    path: route,
    statusCode: Number(statusCode) || 0,
    durationMs: Math.max(0, Math.round(durationMs)),
  });
  prune(at);

  if (statusCode >= 500) {
    recentErrors.unshift({
      at: new Date(at).toISOString(),
      method: String(method || 'GET').toUpperCase(),
      path: route,
      statusCode,
      code: errorCode ? String(errorCode).slice(0, 64) : undefined,
      message: errorMessage ? String(errorMessage).slice(0, 200) : undefined,
    });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.length = MAX_RECENT_ERRORS;
  }
}

// Snapshot of latency / availability for the last 15 minutes.
export function getApiMetrics() {
  prune();
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const total = samples.length;
  const errors5xx = samples.filter((sample) => sample.statusCode >= 500).length;
  const errors4xx = samples.filter((sample) => sample.statusCode >= 400 && sample.statusCode < 500).length;
  const ok2xx = samples.filter((sample) => sample.statusCode >= 200 && sample.statusCode < 300).length;
  const sum = durations.reduce((acc, value) => acc + value, 0);

  const byPath = new Map();
  for (const sample of samples) {
    const key = `${sample.method} ${sample.path}`;
    const row = byPath.get(key) ?? { method: sample.method, path: sample.path, count: 0, errors: 0, totalMs: 0 };
    row.count += 1;
    row.totalMs += sample.durationMs;
    if (sample.statusCode >= 500) row.errors += 1;
    byPath.set(key, row);
  }

  const topRoutes = [...byPath.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map((row) => ({
      route: `${row.method} ${row.path}`,
      count: row.count,
      errors: row.errors,
      avgMs: row.count > 0 ? Math.round(row.totalMs / row.count) : 0,
    }));

  return {
    windowMinutes: 15,
    sampleCount: total,
    availabilityPercent: total > 0 ? Math.round(((total - errors5xx) / total) * 1000) / 10 : 100,
    errorRatePercent: total > 0 ? Math.round((errors5xx / total) * 1000) / 10 : 0,
    latencyMs: {
      avg: total > 0 ? Math.round(sum / total) : null,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
    },
    statusCounts: {
      '2xx': ok2xx,
      '4xx': errors4xx,
      '5xx': errors5xx,
    },
    topRoutes,
    recentErrors: [...recentErrors],
  };
}

// Test helper — clears buffers between cases when needed.
export function resetMetricsForTests() {
  samples.length = 0;
  recentErrors.length = 0;
}
