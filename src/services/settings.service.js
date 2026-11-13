// Reads and updates the safe, admin-editable application settings (stored in AppSetting).
// Secrets such as the MongoDB URI or JWT secrets are never settings and are never returned.

import { EDITABLE_SETTINGS } from '../config/catalog.js';
import { env } from '../config/env.js';
import { AppSetting } from '../models/AppSetting.js';

// Returns one setting's current value, or its default when no admin has changed it.
export async function getSetting(key) {
  const stored = await AppSetting.findOne({ key }).lean();
  return stored ? stored.value : EDITABLE_SETTINGS[key].defaultValue;
}

// Returns every editable setting with its current value, default and allowed range.
export async function getEditableSettings() {
  const stored = await AppSetting.find({ key: { $in: Object.keys(EDITABLE_SETTINGS) } }).lean();
  const storedByKey = new Map(stored.map((setting) => [setting.key, setting]));

  return Object.entries(EDITABLE_SETTINGS).map(([key, rule]) => ({
    key,
    value: storedByKey.get(key)?.value ?? rule.defaultValue,
    defaultValue: rule.defaultValue,
    min: rule.min,
    max: rule.max,
    updatedAt: storedByKey.get(key)?.updatedAt ?? null,
  }));
}

// Saves new values for editable settings (already validated) and returns the previous values.
export async function saveSettings(changes, updatedBy) {
  const previous = {};
  for (const [key, value] of Object.entries(changes)) {
    previous[key] = await getSetting(key);
    await AppSetting.findOneAndUpdate({ key }, { $set: { value, updatedBy } }, { upsert: true });
  }
  return previous;
}

// Read-only facts shown on the admin settings page. None of them is secret.
export function getSystemInfo() {
  const paymentsConfigured =
    (env.payments.provider === 'demo' && env.payments.demoEnabled) ||
    (env.payments.provider === 'razorpay' && env.payments.razorpay.enabled);

  return {
    environment: env.nodeEnv,
    currentTermsVersion: env.currentTermsVersion,
    otpMode: env.otpMode,
    pushNotificationsConfigured: false,
    storeBillingConfigured: paymentsConfigured,
    paymentProvider: env.payments.provider,
    socialSignInConfigured: false,
  };
}
