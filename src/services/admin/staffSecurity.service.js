// Shared staff security helpers. Admin-panel 2FA step-up is disabled.

// Kept as a no-op so privileged staff mutations no longer require a TOTP/backup code.
export async function assertStaffTwoFactor() {
  return;
}
