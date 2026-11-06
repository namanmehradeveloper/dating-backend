// Live system monitoring for ADMIN: API latency, DB/process health, sockets, media,
// jobs, and honest stubs for payments / infrastructure cost (not configured).

import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { env, BACKEND_ROOT } from '../../config/env.js';
import { getDbState, isDbConnected } from '../../config/db.js';
import { Media } from '../../models/Media.js';
import { Profile } from '../../models/Profile.js';
import { User } from '../../models/User.js';
import { VerificationRequest } from '../../models/VerificationRequest.js';
import { getApiMetrics } from '../metrics.service.js';
import { listJobs, registerJob } from '../jobRegistry.service.js';
import { getConnectedSocketCount, getOnlineUserCount } from '../realtime.service.js';
import { getSystemInfo } from '../settings.service.js';
import { getCallsStatus } from './adminCalls.service.js';
import { getPaymentsStatus } from './adminPayments.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const READY_LABELS = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

// Ensure the deletion job appears even before startAccountDeletionJob runs (tests).
registerJob('account-deletion-purge', {
  name: 'Account deletion purge',
  schedule: 'Every 1 hour (in-process)',
});

async function readPackageVersion() {
  try {
    const raw = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

async function pingDatabase() {
  const started = process.hrtime.bigint();
  try {
    if (!isDbConnected()) {
      return { ok: false, latencyMs: null, state: getDbState() };
    }
    await mongoose.connection.db.admin().command({ ping: 1 });
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return { ok: true, latencyMs, state: getDbState() };
  } catch (error) {
    return { ok: false, latencyMs: null, state: getDbState(), error: error.message?.slice(0, 200) };
  }
}

async function loadMediaStats() {
  const since = new Date(Date.now() - DAY_MS);
  const [byPurpose, byStatus, uploadedLast24h, pendingPhotoProfiles, pendingVerifications] = await Promise.all([
    Media.aggregate([{ $group: { _id: '$purpose', count: { $sum: 1 } } }]),
    Media.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Media.countDocuments({ createdAt: { $gte: since } }),
    Profile.countDocuments({ photos: { $elemMatch: { moderationStatus: 'PENDING' } } }),
    VerificationRequest.countDocuments({ status: 'PENDING' }),
  ]);

  return {
    uploadedLast24h,
    byPurpose: Object.fromEntries(byPurpose.map((row) => [row._id ?? 'UNKNOWN', row.count])),
    byStatus: Object.fromEntries(byStatus.map((row) => [row._id ?? 'UNKNOWN', row.count])),
    pendingPhotoModerationProfiles: pendingPhotoProfiles,
    pendingVerificationSelfies: pendingVerifications,
    processing: {
      // Sharp processing is synchronous per upload in this API — no async media queue.
      queueConfigured: false,
      note: 'Uploads are processed inline with Sharp. There is no separate media job queue.',
    },
  };
}

function buildAlerts({ api, database, jobs, payments, calls }) {
  const alerts = [];
  if (!database.ok) {
    alerts.push({
      severity: 'critical',
      source: 'database',
      message: `MongoDB is ${database.state}${database.error ? `: ${database.error}` : ''}`,
    });
  }
  if (api.errorRatePercent >= 5 && api.sampleCount >= 10) {
    alerts.push({
      severity: 'warning',
      source: 'api',
      message: `Elevated 5xx rate: ${api.errorRatePercent}% over the last ${api.windowMinutes} minutes`,
    });
  }
  if (api.latencyMs.p95 != null && api.latencyMs.p95 >= 1500 && api.sampleCount >= 10) {
    alerts.push({
      severity: 'warning',
      source: 'api',
      message: `API p95 latency is ${api.latencyMs.p95} ms`,
    });
  }
  for (const job of jobs) {
    if (job.lastStatus === 'FAILED') {
      alerts.push({
        severity: 'warning',
        source: 'jobs',
        message: `${job.name} failed: ${job.lastError ?? 'unknown error'}`,
      });
    }
  }
  if (!payments.configured) {
    alerts.push({
      severity: 'info',
      source: 'payments',
      message: 'Store billing / payment webhooks are not configured',
    });
  }
  if (!calls.configured) {
    alerts.push({
      severity: 'info',
      source: 'calls',
      message: 'Agora voice/video calling credentials are not configured',
    });
  }
  return alerts;
}

// GET /admin/monitoring
export async function getSystemStatus() {
  const mem = process.memoryUsage();
  const system = getSystemInfo();
  const [database, api, media, packageVersion, scheduledDeletions] = await Promise.all([
    pingDatabase(),
    Promise.resolve(getApiMetrics()),
    loadMediaStats(),
    readPackageVersion(),
    User.countDocuments({ role: 'USER', 'deletion.status': 'SCHEDULED' }),
  ]);

  const calls = getCallsStatus();
  const payments = {
    ...getPaymentsStatus(),
    webhookFailures: null,
    note: 'No payment webhook receiver exists in this API, so failure counts cannot be reported.',
  };
  const jobs = listJobs();
  const socketsConnected = getConnectedSocketCount();
  const alerts = buildAlerts({ api, database, jobs, payments, calls });

  const overall =
    !database.ok || alerts.some((alert) => alert.severity === 'critical')
      ? 'DEGRADED'
      : alerts.some((alert) => alert.severity === 'warning')
        ? 'WARNING'
        : 'HEALTHY';

  return {
    // Backward-compatible fields used by existing admin UI / tests.
    mongoose: {
      readyState: mongoose.connection.readyState,
      state: READY_LABELS[mongoose.connection.readyState] ?? 'unknown',
      pingOk: database.ok,
      pingLatencyMs: database.latencyMs,
    },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryUsage: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
    },
    env: { nodeEnv: env.nodeEnv },
    sockets: {
      connected: socketsConnected,
      onlineMembers: getOnlineUserCount(),
      realtimeAttached: socketsConnected != null,
    },
    pushConfigured: system.pushNotificationsConfigured,
    storeBillingConfigured: system.storeBillingConfigured,

    // Expanded monitoring payload.
    overall,
    api: {
      ...api,
      healthEndpoint: '/api/v1/health',
    },
    database: {
      ...database,
      name: mongoose.connection.name || null,
      host: mongoose.connection.host || null,
    },
    media,
    calls: {
      ...calls,
      signalingHealthy: false,
      activeSessions: null,
    },
    payments,
    jobs: {
      broker: 'in-process',
      note: 'Jobs run inside the API process. There is no Redis/Bull/SQS queue broker.',
      items: jobs,
      scheduledAccountDeletions: scheduledDeletions,
    },
    errors: {
      tracking: 'in-process',
      note: 'Recent 5xx responses from this API process (last 15 minutes of traffic). No external error tracker (Sentry, etc.) is configured.',
      recent: api.recentErrors,
      statusCounts: api.statusCounts,
    },
    deployment: {
      apiVersion: packageVersion,
      nodeVersion: process.version,
      environment: env.nodeEnv,
      gitSha: process.env.GIT_SHA || process.env.COMMIT_SHA || null,
      buildId: process.env.BUILD_ID || null,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    infrastructureCost: {
      configured: false,
      provider: null,
      amount: null,
      currency: null,
      note: 'Infrastructure cost monitoring is not integrated (no cloud billing API credentials).',
    },
    alerts,
    generatedAt: new Date(),
  };
}
