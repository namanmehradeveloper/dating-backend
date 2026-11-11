// Tests .env validation: defaults, every invalid value, CORS origins and production safety rules.

import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv, parseDurationSeconds } from '../../src/config/env.js';

const base = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/dating_cloud',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  OTP_MODE: 'fixed',
  FIXED_OTP: '123456',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  CLIENT_URL: 'https://admin.example.com',
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'cloudinary_api_secret_value',
};

// Runs loadEnv on an invalid environment and returns the list of problems it reported.
function problemsFor(source) {
  try {
    loadEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err.problems;
  }
  throw new Error('Expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('applies documented defaults', () => {
    const env = loadEnv(base);
    expect(env.port).toBe(5050);
    expect(env.host).toBe('0.0.0.0');
    expect(env.appUrl).toBe('http://127.0.0.1:5050');
    expect(env.accessTokenTtlSeconds).toBe(900);
    expect(env.refreshTokenTtlSeconds).toBe(30 * 86400);
    expect(env.otpMode).toBe('fixed');
    expect(env.fixedOtp).toBe('123456');
    expect(env.otpExpirySeconds).toBe(300);
    expect(env.otpResendSeconds).toBe(30);
    expect(env.uploadsDir.replace(/\\/g, '/')).toMatch(/backend\/uploads$/);
    expect(env.cloudinary.enabled).toBe(false);
    expect(env.agora.enabled).toBe(false);
    expect(env.callRingTimeoutSeconds).toBe(30);
    expect(env.trustProxy).toBe(0);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('trusts Render’s single proxy hop by default, while allowing an explicit override', () => {
    expect(loadEnv({ ...base, RENDER: 'true' }).trustProxy).toBe(1);
    expect(loadEnv({ ...base, RENDER: 'true', TRUST_PROXY: '0' }).trustProxy).toBe(0);
    expect(loadEnv({ ...base, RENDER: 'true', TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('enables Cloudinary when all three credentials are set', () => {
    const env = loadEnv({
      ...base,
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: '123456789012345',
      CLOUDINARY_API_SECRET: 'cloudinary_api_secret_value',
    });
    expect(env.cloudinary.enabled).toBe(true);
    expect(env.cloudinary.cloudName).toBe('demo');
  });

  it('rejects partial Cloudinary credentials', () => {
    const problems = problemsFor({ ...base, CLOUDINARY_CLOUD_NAME: 'demo' });
    expect(problems.some((p) => p.includes('CLOUDINARY_'))).toBe(true);
  });

  it('requires both Agora credentials when either is configured', () => {
    const problems = problemsFor({ ...base, AGORA_APP_ID: '0123456789abcdef0123456789abcdef' });
    expect(problems).toContain('AGORA_APP_ID and AGORA_APP_CERTIFICATE must both be set to enable calling');
    const configured = loadEnv({
      ...base,
      AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
      AGORA_APP_CERTIFICATE: 'abcdef0123456789abcdef0123456789',
    });
    expect(configured.agora).toMatchObject({ enabled: true, appId: '0123456789abcdef0123456789abcdef' });
    expect(configured.agora.appCertificate).toBe('abcdef0123456789abcdef0123456789');
  });

  it('requires Cloudinary in production', () => {
    const { CLOUDINARY_CLOUD_NAME: _n, CLOUDINARY_API_KEY: _k, CLOUDINARY_API_SECRET: _s, ...without } = production;
    const problems = problemsFor({ ...without, ALLOW_FIXED_OTP: 'true' });
    expect(problems.some((p) => p.includes('CLOUDINARY_'))).toBe(true);
  });

  it('reports every problem at once', () => {
    const problems = problemsFor({ NODE_ENV: 'development' });
    expect(problems).toEqual(
      expect.arrayContaining([
        'MONGODB_URI is required',
        'JWT_ACCESS_SECRET is required',
        'JWT_REFRESH_SECRET is required',
        expect.stringContaining('FIXED_OTP'),
      ]),
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['MONGODB_URI', 'http://localhost'],
    ['APP_URL', 'not a url'],
    ['CLIENT_URL', 'ftp://admin.example.com'],
    ['ACCESS_TOKEN_EXPIRES_IN', '15 minutes'],
    ['REFRESH_TOKEN_EXPIRES_IN', '0d'],
    ['OTP_MODE', 'email'],
    ['FIXED_OTP', '12345'],
    ['FIXED_OTP', 'abcdef'],
    ['OTP_EXPIRY_SECONDS', '5'],
    ['ALLOW_FIXED_OTP', 'yes'],
  ])('rejects invalid %s=%s', (key, value) => {
    const problems = problemsFor({ ...base, [key]: value });
    expect(problems.some((p) => p.includes(key))).toBe(true);
  });

  it('requires different access and refresh secrets', () => {
    const problems = problemsFor({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET });
    expect(problems).toContain('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  });

  it('does not require FIXED_OTP when OTP_MODE=sms', () => {
    const env = loadEnv({ ...base, OTP_MODE: 'sms', FIXED_OTP: '' });
    expect(env.otpMode).toBe('sms');
    expect(env.fixedOtp).toBeUndefined();
  });

  describe('CORS origins', () => {
    it('always allows local Vite and Next.js origins outside production', () => {
      const env = loadEnv({ ...base, CLIENT_URL: 'http://127.0.0.1:5173, http://192.168.1.10:5173/' });
      expect(env.corsOrigins).toEqual([
        'http://127.0.0.1:5173',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://localhost:3000',
        'http://192.168.1.10:5173',
      ]);
    });

    it('merges ADMIN_URL and WEB_URL with CLIENT_URL', () => {
      const env = loadEnv({
        ...production,
        ALLOW_FIXED_OTP: 'true',
        CLIENT_URL: '',
        ADMIN_URL: 'https://admin.example.com',
        WEB_URL: 'https://web.example.com',
      });
      expect(env.corsOrigins).toEqual(['https://admin.example.com', 'https://web.example.com']);
    });

    it('uses only listed origins in production', () => {
      const env = loadEnv({ ...production, ALLOW_FIXED_OTP: 'true' });
      expect(env.corsOrigins).toEqual(['https://admin.example.com']);
    });

    it('requires a browser origin list in production', () => {
      const problems = problemsFor({ ...production, CLIENT_URL: '', ALLOW_FIXED_OTP: 'true' });
      expect(problems.some((p) => p.includes('ADMIN_URL, WEB_URL, or CLIENT_URL'))).toBe(true);
    });
  });

  describe('production safety', () => {
    it('refuses OTP_MODE=fixed without ALLOW_FIXED_OTP=true', () => {
      const problems = problemsFor(production);
      expect(problems.some((p) => p.includes('OTP_MODE=fixed is not allowed in production'))).toBe(true);
    });

    it('allows OTP_MODE=fixed when ALLOW_FIXED_OTP=true is set deliberately', () => {
      const env = loadEnv({ ...production, ALLOW_FIXED_OTP: 'true' });
      expect(env.otpMode).toBe('fixed');
      expect(env.allowFixedOtp).toBe(true);
    });

    it.each([
      ['placeholder', 'change_this_access_secret_but_long_enough_now'],
      ['short', 'tooShort'],
    ])('refuses a %s JWT secret', (_label, value) => {
      const problems = problemsFor({ ...production, ALLOW_FIXED_OTP: 'true', JWT_ACCESS_SECRET: value });
      expect(problems.some((p) => p.startsWith('JWT_ACCESS_SECRET'))).toBe(true);
    });
  });
});

describe('parseDurationSeconds', () => {
  it.each([
    ['900', 900],
    ['45s', 45],
    ['15m', 900],
    ['12h', 43200],
    ['30d', 2592000],
  ])('%s -> %i', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });

  it.each(['', '0', '-5m', '1w', '15 m', 'abc'])('rejects %j', (input) => {
    expect(parseDurationSeconds(input)).toBeNull();
  });
});
