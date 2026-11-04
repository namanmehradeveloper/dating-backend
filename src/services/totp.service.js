// RFC 6238 TOTP helpers for staff 2FA (HMAC-SHA1, 30s steps, 6 digits). No extra packages.

import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(input).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

export function buildOtpAuthUrl({ secret, email, issuer = 'Dating Cloud Admin' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateTotpCode(secret, { now = Date.now() } = {}) {
  const secretBuf = base32Decode(secret);
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  return hotp(secretBuf, counter);
}

export function verifyTotp(secret, token, { window = 1, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token.trim())) return false;
  let secretBuf;
  try {
    secretBuf = base32Decode(secret);
  } catch {
    return false;
  }
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const expected = token.trim();
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secretBuf, counter + offset) === expected) return true;
  }
  return false;
}

export function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(crypto.randomBytes(4).toString('hex'));
  }
  return codes;
}
