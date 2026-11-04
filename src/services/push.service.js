// Remote push delivery (Firebase Cloud Messaging). FCM credentials are not configured in this
// project yet, so delivery is skipped and reported as FEATURE_NOT_CONFIGURED; the in-app
// notification inbox keeps working locally.

export const PUSH_NOT_CONFIGURED = 'FEATURE_NOT_CONFIGURED';

// Returns true when push delivery can be attempted.
export function isPushConfigured() {
  return false;
}

// Attempts to send a push to a member's devices. Payloads never contain message text or location.
export async function sendPushToUser() {
  return { status: PUSH_NOT_CONFIGURED };
}
