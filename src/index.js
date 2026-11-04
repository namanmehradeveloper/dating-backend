// Starts the API server: connects to MongoDB, then listens on PORT (5050 by default).
// Flutter and the React admin call this server directly; there is no proxy.

import http from 'node:http';
import { env } from './config/env.js';
import { connectDB, disconnectDB, ensureIndexes } from './config/db.js';
import './models/index.js';
import { createApp, API_PREFIX } from './app.js';
import { startAccountDeletionJob } from './jobs/accountDeletion.job.js';
import { ensureDefaultInterests } from './services/interest.service.js';
import { ensureUploadFolders } from './services/media.service.js';
import { createSocketServer } from './socket/index.js';
import { logger } from './utils/logger.js';

// Connects to MongoDB and starts the HTTP server. Exits when the database is unreachable.
async function startServer() {
  if (env.otpMode === 'fixed') {
    logger.warn('OTP_MODE=fixed: every sign-in code is the FIXED_OTP value. Development/testing only.');
  }

  try {
    await connectDB();
  } catch (error) {
    logger.error('Could not connect to MongoDB. Check MONGODB_URI and that MongoDB is running.', { error: error.message });
    process.exit(1);
  }
  logger.info('MongoDB connected');

  try {
    await ensureIndexes();
  } catch (error) {
    logger.error(
      'Could not build MongoDB indexes. The database probably holds data from an older schema; ' +
        'see docs/environment_setup.md ("Existing local data").',
      { error: error.message },
    );
    process.exit(1);
  }
  await ensureUploadFolders();
  await ensureDefaultInterests();
  startAccountDeletionJob();

  const server = http.createServer(createApp());
  const io = createSocketServer(server);
  server.listen(env.port, env.host, () => {
    logger.info(`API listening on http://127.0.0.1:${env.port}${API_PREFIX}`, { host: env.host, environment: env.nodeEnv });
    logger.info(`Socket.IO listening on ws://127.0.0.1:${env.port}/v1`);
  });

  listenForShutdown(server, io);
}

// Closes the server and the database connection cleanly when the process is stopped (Ctrl+C or SIGTERM).
function listenForShutdown(server, io) {
  let isShuttingDown = false;

  // Runs once per process: stops accepting requests, closes MongoDB, then exits.
  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received, shutting down`);
    io.close();
    server.close();
    await disconnectDB().catch(() => {});
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason.stack : String(reason);
    logger.error('Unhandled promise rejection', { error });
  });
}

startServer();
