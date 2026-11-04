// Effective profile visibility for discovery and public profile lookups.

export function getEffectiveVisibility(profile, now = new Date()) {
  const status = profile.visibilityStatus || 'VISIBLE';
  if (status === 'HIDDEN') return 'HIDDEN';
  if (status === 'PAUSED') {
    if (profile.pausedUntil && new Date(profile.pausedUntil) <= now) return 'VISIBLE';
    return 'PAUSED';
  }
  if (status === 'SNOOZED') {
    if (profile.snoozedUntil && new Date(profile.snoozedUntil) <= now) return 'VISIBLE';
    return 'SNOOZED';
  }
  return 'VISIBLE';
}

export function isDiscoverableProfile(profile, now = new Date()) {
  const privacy = profile.privacy ?? {};
  if (privacy.incognito) return false;
  return getEffectiveVisibility(profile, now) === 'VISIBLE';
}
