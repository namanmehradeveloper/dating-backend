// Payments / store billing status for ADMIN. No card storage; billing is not configured.

import { getSystemInfo } from '../settings.service.js';

// GET /admin/payments/status
export function getPaymentsStatus() {
  const system = getSystemInfo();
  return {
    configured: false,
    storeBillingConfigured: system.storeBillingConfigured,
    reason: 'In-app payments and card processing are not implemented in this API. Store billing is not configured.',
  };
}
