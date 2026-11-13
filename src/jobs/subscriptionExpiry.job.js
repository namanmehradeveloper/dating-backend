// Downgrades expired Plus entitlements. Runs every 15 minutes inside the API process.

import { downgradeExpiredSubscriptions } from '../services/subscription.service.js';
import { markJobFailed, markJobStarted, markJobSucceeded, registerJob } from '../services/jobRegistry.service.js';
import { logger } from '../utils/logger.js';

const RUN_EVERY_MS = 15 * 60 * 1000;
const JOB_ID = 'subscription-expiry';

registerJob(JOB_ID, {
  name: 'Subscription expiry downgrade',
  schedule: 'Every 15 minutes (in-process)',
});

export function startSubscriptionExpiryJob() {
  const run = async () => {
    markJobStarted(JOB_ID);
    try {
      const downgraded = await downgradeExpiredSubscriptions();
      markJobSucceeded(JOB_ID, { downgraded });
      if (downgraded > 0) logger.info('Downgraded expired subscriptions', { downgraded });
    } catch (error) {
      markJobFailed(JOB_ID, error);
      logger.error('Subscription expiry job failed', { error: error.message });
    }
  };

  run();
  const timer = setInterval(run, RUN_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
