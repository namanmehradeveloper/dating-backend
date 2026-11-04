// Validates the request bodies of the /auth endpoints.

import {
  checkEmail,
  checkIsoDate,
  checkPhoneNumber,
  checkText,
  isMissing,
  requireObjectBody,
  throwIfInvalid,
} from './common.js';

export const SOCIAL_PROVIDERS = ['apple', 'google'];

// POST /auth/otp/request: { phoneNumber } in E.164 format.
export function validateOtpRequest(body) {
  requireObjectBody(body);
  const details = [];
  const phoneNumber = checkPhoneNumber(details, body.phoneNumber);
  throwIfInvalid(details);
  return { phoneNumber };
}

// POST /auth/otp/verify: { phoneNumber, code } where code is 6 digits.
export function validateOtpVerify(body) {
  requireObjectBody(body);
  const details = [];
  const phoneNumber = checkPhoneNumber(details, body.phoneNumber);

  if (isMissing(body.code)) {
    details.push({ field: 'code', reason: 'REQUIRED' });
  } else if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    details.push({ field: 'code', reason: 'INVALID_FORMAT' });
  }

  throwIfInvalid(details);
  return { phoneNumber, code: body.code };
}

// POST /auth/token/refresh and /auth/logout: { refreshToken }.
export function validateRefreshToken(body) {
  requireObjectBody(body);
  const details = [];
  const refreshToken = checkText(details, 'refreshToken', body.refreshToken, { max: 512, reason: 'INVALID' });
  throwIfInvalid(details);
  return { refreshToken };
}

// POST /auth/register: email, password (10–128), displayName (1–40), dateOfBirth and Terms version.
export function validateRegister(body) {
  requireObjectBody(body);
  const details = [];
  const email = checkEmail(details, body.email);

  if (isMissing(body.password)) {
    details.push({ field: 'password', reason: 'REQUIRED' });
  } else if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
    details.push({ field: 'password', reason: 'LENGTH_10_128' });
  }

  const displayName = checkText(details, 'displayName', body.displayName, { max: 40, reason: 'LENGTH_1_40' });
  const dateOfBirth = checkIsoDate(details, 'dateOfBirth', body.dateOfBirth);
  const acceptedTermsVersion = checkText(details, 'acceptedTermsVersion', body.acceptedTermsVersion, { max: 20 });

  throwIfInvalid(details);
  return { email, password: body.password, displayName, dateOfBirth, acceptedTermsVersion };
}

// POST /auth/login: { email, password }.
export function validateLogin(body) {
  requireObjectBody(body);
  const details = [];
  const email = checkEmail(details, body.email);
  if (isMissing(body.password) || typeof body.password !== 'string') {
    details.push({ field: 'password', reason: 'REQUIRED' });
  }
  throwIfInvalid(details);
  return { email, password: body.password };
}

// POST /auth/login/2fa: { pendingToken, code }.
export function validateTwoFactorLogin(body) {
  requireObjectBody(body);
  const details = [];
  const pendingToken = checkText(details, 'pendingToken', body.pendingToken, { max: 2048, reason: 'INVALID' });
  if (isMissing(body.code) || typeof body.code !== 'string' || body.code.trim().length < 6) {
    details.push({ field: 'code', reason: 'INVALID_FORMAT' });
  }
  throwIfInvalid(details);
  return { pendingToken, code: body.code.trim() };
}

// POST /auth/social/{provider}: { idToken, nonce? }.
export function validateSocialSignIn(body) {
  requireObjectBody(body);
  const details = [];
  const idToken = checkText(details, 'idToken', body.idToken, { max: 8192, reason: 'INVALID' });
  const nonce = checkText(details, 'nonce', body.nonce, { max: 256, reason: 'INVALID', required: false });
  throwIfInvalid(details);
  return { idToken, nonce };
}
