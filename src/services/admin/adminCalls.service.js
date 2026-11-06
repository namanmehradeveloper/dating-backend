import { env } from '../../config/env.js';

// GET /admin/calls/status
export function getCallsStatus() {
  return {
    configured: env.agora.enabled,
    reason: env.agora.enabled ? null : 'Agora voice/video calling credentials are not configured.',
  };
}
