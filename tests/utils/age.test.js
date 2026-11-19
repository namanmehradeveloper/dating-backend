import { describe, expect, it } from 'vitest';
import {
  MINIMUM_AGE,
  calculateAge,
  earliestBirthDateForAge,
  latestBirthDateForAge,
} from '../../src/utils/age.js';

function utcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

describe('age helpers', () => {
  it('exports MINIMUM_AGE of 18', () => {
    expect(MINIMUM_AGE).toBe(18);
  });

  it('treats exactly 18 years old today as eligible', () => {
    const today = utcDate(2026, 10, 19); // 2026-11-19
    const dob = latestBirthDateForAge(18, today);
    expect(iso(dob)).toBe('2008-11-19');
    expect(calculateAge(dob, today)).toBe(18);
  });

  it('treats one day under 18 as ineligible', () => {
    const today = utcDate(2026, 10, 19);
    const maxAdult = latestBirthDateForAge(18, today);
    const under18 = new Date(maxAdult);
    under18.setUTCDate(under18.getUTCDate() + 1);
    expect(iso(under18)).toBe('2008-11-20');
    expect(calculateAge(under18, today)).toBe(17);
  });

  it('rejects future dates as under-age', () => {
    const today = utcDate(2026, 10, 19);
    const tomorrow = utcDate(2026, 10, 20);
    expect(calculateAge(tomorrow, today)).toBeLessThan(0);
    expect(calculateAge(tomorrow, today)).toBeLessThan(MINIMUM_AGE);
  });

  it('handles leap-day birthdays on non-leap anniversaries', () => {
    // Born 2008-02-29; on 2026-02-28 they are still 17; on 2026-03-01 they turn 18.
    const leapDob = utcDate(2008, 1, 29);
    expect(calculateAge(leapDob, utcDate(2026, 1, 28))).toBe(17);
    expect(calculateAge(leapDob, utcDate(2026, 2, 1))).toBe(18);
  });

  it('clamps latestBirthDateForAge on leap day so exactly-18 stays inclusive', () => {
    const leapToday = utcDate(2024, 1, 29); // 2024-02-29
    const maxAdult = latestBirthDateForAge(18, leapToday);
    // 2006 is not a leap year → clamp to 2006-02-28 (not Mar 1).
    expect(iso(maxAdult)).toBe('2006-02-28');
    expect(calculateAge(maxAdult, leapToday)).toBe(18);
    expect(calculateAge(utcDate(2006, 2, 1), leapToday)).toBe(17);
  });

  it('keeps earliest/latest birth-date range consistent for age filters', () => {
    const today = utcDate(2026, 5, 15);
    const earliestFor99 = earliestBirthDateForAge(99, today);
    const latestFor18 = latestBirthDateForAge(18, today);
    expect(calculateAge(latestFor18, today)).toBe(18);
    expect(calculateAge(earliestFor99, today)).toBe(99);
    expect(earliestFor99.getTime()).toBeLessThan(latestFor18.getTime());
  });
});
