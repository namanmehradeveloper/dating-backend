// Age helpers. The server's age calculation is the authoritative 18+ check.

export const MINIMUM_AGE = 18;

// Returns the age in whole years on the given date (today by default).
export function calculateAge(dateOfBirth, onDate = new Date()) {
  const birth = new Date(dateOfBirth);
  let age = onDate.getUTCFullYear() - birth.getUTCFullYear();

  const hadBirthdayThisYear =
    onDate.getUTCMonth() > birth.getUTCMonth() ||
    (onDate.getUTCMonth() === birth.getUTCMonth() && onDate.getUTCDate() >= birth.getUTCDate());

  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

// Returns the latest birth date that still makes someone `age` years old today.
// Used to turn an age range into a dateOfBirth range for database queries.
export function latestBirthDateForAge(age, onDate = new Date()) {
  return new Date(Date.UTC(onDate.getUTCFullYear() - age, onDate.getUTCMonth(), onDate.getUTCDate()));
}

// Returns the earliest birth date for someone who is at most `age` years old today.
export function earliestBirthDateForAge(age, onDate = new Date()) {
  const date = latestBirthDateForAge(age + 1, onDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}
