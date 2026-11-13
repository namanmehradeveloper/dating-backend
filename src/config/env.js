// Loads and validates the backend settings from backend/.env.
// Other files import `env` from here instead of reading process.env, so a broken
// .env is reported once, clearly, when the server starts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const NODE_ENVS = ['development', 'test', 'production'];
const OTP_MODES = ['fixed', 'sms'];
// Local browser apps that call the API directly (admin Vite + member Next.js).
const DEV_BROWSER_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];
const PLACEHOLDER_SECRET_PREFIX = 'change_this';
const MIN_PRODUCTION_SECRET_LENGTH = 32;
const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 };

// Error thrown when .env is invalid. `problems` lists every invalid setting so they can all be fixed at once.
export class ConfigError extends Error {
  constructor(problems) {
    const list = problems.map((problem) => `  - ${problem}`).join('\n');
    super(`Invalid backend configuration:\n${list}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// Converts a duration such as "900", "45s", "15m", "12h" or "30d" into seconds. Returns null when invalid.
export function parseDurationSeconds(value) {
  const match = /^(\d+)([smhd])?$/.exec(String(value).trim());
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const seconds = amount * SECONDS_PER_UNIT[unit];
  return seconds > 0 ? seconds : null;
}

// Returns the origin (protocol, host and port) of an http(s) URL, or null when the value is not one.
function toOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Returns the trimmed value of a setting, or the fallback when it is missing or blank.
function readText(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

// Reads a whole-number setting between min and max. Records a problem and uses the fallback when invalid.
function readInteger(source, problems, key, fallback, min, max) {
  const text = readText(source, key);
  if (text === undefined) return fallback;

  const number = Number(text);
  if (!Number.isInteger(number) || number < min || number > max) {
    problems.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return number;
}

// Reads a "true"/"false" setting. Records a problem and uses the fallback for any other value.
function readBoolean(source, problems, key, fallback) {
  const text = readText(source, key);
  if (text === undefined) return fallback;
  if (text === 'true') return true;
  if (text === 'false') return false;

  problems.push(`${key} must be "true" or "false"`);
  return fallback;
}

// Reads a duration setting such as "15m" and returns both the original text and its length in seconds.
function readDuration(source, problems, key, fallback) {
  const text = readText(source, key, fallback);
  const seconds = parseDurationSeconds(text);
  if (seconds === null) {
    problems.push(`${key} must be a duration like 900, 15m, 12h or 30d`);
  }
  return { text, seconds };
}

// Reads NODE_ENV (development, test or production). Defaults to development.
function readNodeEnv(source, problems) {
  const nodeEnv = readText(source, 'NODE_ENV', 'development');
  if (!NODE_ENVS.includes(nodeEnv)) {
    problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
  }
  return nodeEnv;
}

// Reads the MongoDB connection string. Local development uses mongodb://127.0.0.1:27017/dating_cloud.
function readMongoUri(source, problems) {
  const mongodbUri = readText(source, 'MONGODB_URI');
  if (!mongodbUri) {
    problems.push('MONGODB_URI is required');
  } else if (!mongodbUri.startsWith('mongodb://') && !mongodbUri.startsWith('mongodb+srv://')) {
    problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }
  return mongodbUri;
}

// Reads APP_URL, the public base URL used to build absolute image URLs such as
// http://127.0.0.1:5050/uploads/profile/file.jpg. Defaults to the local server address.
function readAppUrl(source, problems, port) {
  const appUrl = toOrigin(readText(source, 'APP_URL', `http://127.0.0.1:${port}`));
  if (!appUrl) {
    problems.push('APP_URL must be an absolute http(s) URL');
  }
  return appUrl;
}

// Reads one comma-separated list of browser origins into `origins`.
function readOriginList(source, problems, key, origins) {
  const entries = readText(source, key, '').split(',');

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const origin = toOrigin(trimmed);
    if (origin) {
      origins.push(origin);
    } else {
      problems.push(`${key} contains an invalid origin: "${trimmed}"`);
    }
  }
}

// Builds the CORS allow-list for browser apps that call the API directly (admin + web).
// ADMIN_URL / WEB_URL / CLIENT_URL (legacy alias) are merged. In development the local
// Vite (5173) and Next.js (3000) origins are always allowed; production uses only the list.
function readCorsOrigins(source, problems, isProduction) {
  const clientOrigins = [];
  readOriginList(source, problems, 'ADMIN_URL', clientOrigins);
  readOriginList(source, problems, 'WEB_URL', clientOrigins);
  readOriginList(source, problems, 'CLIENT_URL', clientOrigins);

  if (isProduction) {
    if (clientOrigins.length === 0) {
      problems.push('ADMIN_URL, WEB_URL, or CLIENT_URL must list the browser app origin(s) in production');
    }
    return [...new Set(clientOrigins)];
  }
  return [...new Set([...DEV_BROWSER_ORIGINS, ...clientOrigins])];
}

// Reads one JWT signing secret. Production rejects the placeholder values and secrets that are too short.
function readSecret(source, problems, key, isProduction) {
  const secret = readText(source, key);
  if (!secret) {
    problems.push(`${key} is required`);
    return undefined;
  }

  const isWeak = secret.startsWith(PLACEHOLDER_SECRET_PREFIX) || secret.length < MIN_PRODUCTION_SECRET_LENGTH;
  if (isProduction && isWeak) {
    problems.push(`${key} must be a unique random value of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
  }
  return secret;
}

// Reads the JWT secrets and the access/refresh token lifetimes (15m and 30d by default).
function readJwtSettings(source, problems, isProduction) {
  const jwtAccessSecret = readSecret(source, problems, 'JWT_ACCESS_SECRET', isProduction);
  const jwtRefreshSecret = readSecret(source, problems, 'JWT_REFRESH_SECRET', isProduction);
  if (jwtAccessSecret && jwtAccessSecret === jwtRefreshSecret) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }

  const accessToken = readDuration(source, problems, 'ACCESS_TOKEN_EXPIRES_IN', '15m');
  const refreshToken = readDuration(source, problems, 'REFRESH_TOKEN_EXPIRES_IN', '30d');

  return {
    jwtAccessSecret,
    jwtRefreshSecret,
    accessTokenExpiresIn: accessToken.text,
    accessTokenTtlSeconds: accessToken.seconds,
    refreshTokenExpiresIn: refreshToken.text,
    refreshTokenTtlSeconds: refreshToken.seconds,
  };
}

// Reads the OTP settings. OTP_MODE=fixed is TEMPORARY development/testing behaviour: no SMS is sent
// and every code is FIXED_OTP. Production refuses it unless ALLOW_FIXED_OTP=true is set deliberately.
function readOtpSettings(source, problems, isProduction) {
  const otpMode = readText(source, 'OTP_MODE', 'fixed');
  if (!OTP_MODES.includes(otpMode)) {
    problems.push(`OTP_MODE must be one of ${OTP_MODES.join(', ')}`);
  }

  const fixedOtp = readText(source, 'FIXED_OTP');
  const allowFixedOtp = readBoolean(source, problems, 'ALLOW_FIXED_OTP', false);

  if (otpMode === 'fixed') {
    if (!fixedOtp || !/^\d{6}$/.test(fixedOtp)) {
      problems.push('FIXED_OTP must be exactly 6 digits when OTP_MODE=fixed');
    }
    if (isProduction && !allowFixedOtp) {
      problems.push(
        'OTP_MODE=fixed is not allowed in production. Configure an SMS provider, or set ALLOW_FIXED_OTP=true for a deliberate production test',
      );
    }
  }

  return {
    otpMode,
    fixedOtp: otpMode === 'fixed' ? fixedOtp : undefined,
    allowFixedOtp,
    otpExpirySeconds: readInteger(source, problems, 'OTP_EXPIRY_SECONDS', 300, 30, 3600),
    otpResendSeconds: readInteger(source, problems, 'OTP_RESEND_SECONDS', 30, 1, 3600),
  };
}

// Reads Cloudinary credentials. All three must be set together; production requires them.
function readCloudinarySettings(source, problems, isProduction) {
  const cloudName = readText(source, 'CLOUDINARY_CLOUD_NAME');
  const apiKey = readText(source, 'CLOUDINARY_API_KEY');
  const apiSecret = readText(source, 'CLOUDINARY_API_SECRET');
  const present = [cloudName, apiKey, apiSecret].filter(Boolean).length;

  if (present > 0 && present < 3) {
    problems.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must all be set together');
  }
  if (isProduction && present === 0) {
    problems.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required in production');
  }

  return {
    enabled: present === 3,
    cloudName: cloudName || undefined,
    apiKey: apiKey || undefined,
    apiSecret: apiSecret || undefined,
  };
}

// Reads Agora credentials as an optional pair. The certificate stays server-side.
function readAgoraSettings(source, problems) {
  const appId = readText(source, 'AGORA_APP_ID');
  const appCertificate = readText(source, 'AGORA_APP_CERTIFICATE');
  if (Boolean(appId) !== Boolean(appCertificate)) {
    problems.push('AGORA_APP_ID and AGORA_APP_CERTIFICATE must both be set to enable calling');
  }
  if (appId && !/^[a-f\d]{32}$/i.test(appId)) problems.push('AGORA_APP_ID must be a 32-character hexadecimal value');
  if (appCertificate && !/^[a-f\d]{32}$/i.test(appCertificate)) {
    problems.push('AGORA_APP_CERTIFICATE must be a 32-character hexadecimal value');
  }
  return {
    enabled: Boolean(appId && appCertificate),
    appId: appId || undefined,
    appCertificate: appCertificate || undefined,
  };
}

const PAYMENT_PROVIDERS = ['demo', 'razorpay'];

// Payment provider selection. Demo is for local/staging only unless DEMO_PAYMENTS_ENABLED=true.
// Razorpay keys are optional until the adapter is implemented; presence alone marks it enabled.
function readPaymentSettings(source, problems, isProduction, isTest) {
  const provider = readText(source, 'PAYMENT_PROVIDER', isProduction ? 'razorpay' : 'demo');
  if (!PAYMENT_PROVIDERS.includes(provider)) {
    problems.push(`PAYMENT_PROVIDER must be one of ${PAYMENT_PROVIDERS.join(', ')}`);
  }

  const demoEnabledFlag = readBoolean(source, problems, 'DEMO_PAYMENTS_ENABLED', !isProduction);
  if (isProduction && provider === 'demo' && !demoEnabledFlag) {
    problems.push('PAYMENT_PROVIDER=demo is not allowed in production unless DEMO_PAYMENTS_ENABLED=true');
  }
  if (isProduction && demoEnabledFlag && provider === 'demo') {
    // Deliberate production demo — allowed only with the explicit flag above.
  }

  const razorpayKeyId = readText(source, 'RAZORPAY_KEY_ID');
  const razorpayKeySecret = readText(source, 'RAZORPAY_KEY_SECRET');
  const razorpayWebhookSecret = readText(source, 'RAZORPAY_WEBHOOK_SECRET');
  if (Boolean(razorpayKeyId) !== Boolean(razorpayKeySecret)) {
    problems.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must both be set together');
  }
  const razorpayEnabled = Boolean(razorpayKeyId && razorpayKeySecret);
  if (provider === 'razorpay' && !razorpayEnabled && !isTest) {
    // Allowed at boot so the API can run before Razorpay is wired; calls return FEATURE_NOT_CONFIGURED.
  }

  const razorpayEnvironment = readText(source, 'RAZORPAY_ENVIRONMENT', isProduction ? 'live' : 'test');
  if (!['test', 'live'].includes(razorpayEnvironment)) {
    problems.push('RAZORPAY_ENVIRONMENT must be test or live');
  }

  return {
    provider,
    demoEnabled: demoEnabledFlag && (provider === 'demo' || !isProduction || isTest),
    demoWebhookSecret: readText(source, 'DEMO_WEBHOOK_SECRET') || undefined,
    razorpay: Object.freeze({
      enabled: razorpayEnabled,
      keyId: razorpayKeyId || undefined,
      keySecret: razorpayKeySecret || undefined,
      webhookSecret: razorpayWebhookSecret || undefined,
      environment: razorpayEnvironment,
    }),
  };
}

// Validates a raw environment (normally process.env) and returns the frozen configuration object.
// Every problem is collected first and thrown as one ConfigError, so a broken .env is fixed in one pass.
export function loadEnv(source = process.env) {
  const problems = [];

  const nodeEnv = readNodeEnv(source, problems);
  const isProduction = nodeEnv === 'production';
  const port = readInteger(source, problems, 'PORT', 5050, 1, 65535);

  const cloudinary = readCloudinarySettings(source, problems, isProduction);
  const isTest = nodeEnv === 'test';
  const payments = readPaymentSettings(source, problems, isProduction, isTest);

  const config = {
    nodeEnv,
    isProduction,
    isTest,
    isDevelopment: nodeEnv === 'development',
    port,
    host: readText(source, 'HOST', '0.0.0.0'),
    mongodbUri: readMongoUri(source, problems),
    appUrl: readAppUrl(source, problems, port),
    corsOrigins: Object.freeze(readCorsOrigins(source, problems, isProduction)),
    ...readJwtSettings(source, problems, isProduction),
    ...readOtpSettings(source, problems, isProduction),
    trustProxy: readInteger(source, problems, 'TRUST_PROXY', source.RENDER === 'true' ? 1 : 0, 0, 10),
    jsonBodyLimit: readText(source, 'JSON_BODY_LIMIT', '100kb'),
    // Local disk fallback when Cloudinary is off (tests). Production uses Cloudinary.
    uploadsDir: path.resolve(BACKEND_ROOT, readText(source, 'UPLOADS_DIR', 'uploads')),
    currentTermsVersion: readText(source, 'TERMS_VERSION', '2026-01'),
    cloudinary: Object.freeze(cloudinary),
    agora: Object.freeze(readAgoraSettings(source, problems)),
    callRingTimeoutSeconds: readInteger(source, problems, 'CALL_RING_TIMEOUT_SECONDS', 30, 10, 120),
    payments: Object.freeze(payments),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}

// Tests set their own values in vitest.config.js, so backend/.env is only read outside tests.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(BACKEND_ROOT, '.env'), quiet: true });
}

export const env = loadEnv(process.env);
