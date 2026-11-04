// Voice/video calling is not implemented — honest stub for the admin panel.

// GET /admin/calls/status
export function getCallsStatus() {
  return {
    configured: false,
    reason: 'Voice/video calling is not implemented in this API.',
  };
}
