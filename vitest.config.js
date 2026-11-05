// Vitest settings. Tests use fixed, fake configuration values and an in-memory MongoDB (see tests/helpers).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globalSetup: ['tests/helpers/globalSetup.js'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      TRUST_PROXY: '1',
      PORT: '5050',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/dating_cloud_test_unused',
      APP_URL: 'http://127.0.0.1:5050',
      CLIENT_URL: 'http://127.0.0.1:5173',
      JWT_ACCESS_SECRET: 'test_access_secret_0123456789abcdef0123456789',
      JWT_REFRESH_SECRET: 'test_refresh_secret_0123456789abcdef012345678',
      ACCESS_TOKEN_EXPIRES_IN: '15m',
      REFRESH_TOKEN_EXPIRES_IN: '30d',
      OTP_MODE: 'fixed',
      FIXED_OTP: '123456',
      OTP_EXPIRY_SECONDS: '300',
      OTP_RESEND_SECONDS: '30',
      UPLOADS_DIR: 'tests/.uploads',
    },
  },
});
