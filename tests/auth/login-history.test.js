import request from 'supertest';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { LoginHistory } from '../../src/models/LoginHistory.js';
import { User } from '../../src/models/User.js';
import { recordLoginActivity } from '../../src/services/loginHistory.service.js';
import { nextPhoneNumber, useTestDatabase } from '../helpers/factories.js';

const app = createApp();

describe('login activity tracking', () => {
  useTestDatabase();
  afterEach(() => vi.unstubAllGlobals());

  it('records OTP logins with the request IP and parsed client details', async () => {
    const phoneNumber = nextPhoneNumber();
    await request(app).post('/api/v1/auth/otp/request').send({ phoneNumber });

    const response = await request(app)
      .post('/api/v1/auth/otp/verify')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1')
      .send({ phoneNumber, code: '123456' });

    expect(response.status).toBe(200);
    const history = await LoginHistory.findOne({ userId: response.body.data.user.id });
    expect(history).toMatchObject({
      ipAddress: '127.0.0.1',
      deviceName: 'iPhone',
      deviceType: 'MOBILE',
      browser: 'Safari',
      operatingSystem: 'iOS',
    });
    expect(history.loginAt).toBeInstanceOf(Date);
  });

  it('records successful email/password logins only', async () => {
    const password = 'correct-horse-battery';
    const user = await User.create({
      email: 'login-history@example.test',
      passwordHash: await bcrypt.hash(password, 4),
    });

    const failure = await request(app).post('/api/v1/auth/login')
      .send({ email: user.email, password: 'incorrect-password' });
    expect(failure.status).toBe(401);
    expect(await LoginHistory.countDocuments({ userId: user._id })).toBe(0);

    const success = await request(app).post('/api/v1/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36')
      .send({ email: user.email, password });

    expect(success.status).toBe(200);
    expect(await LoginHistory.countDocuments({ userId: user._id })).toBe(1);
    const history = await LoginHistory.findOne({ userId: user._id });
    expect(history).toMatchObject({
      deviceName: 'Windows PC',
      deviceType: 'DESKTOP',
      browser: 'Chrome',
      operatingSystem: 'Windows',
    });
  });

  it('stores available details when IP geolocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await recordLoginActivity('usr_test', {
      ipAddress: '8.8.8.8',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A) Chrome/120.0.0.0 Mobile',
    });

    const history = await LoginHistory.findOne({ userId: 'usr_test' });
    expect(history).toMatchObject({
      ipAddress: '8.8.8.8',
      deviceName: 'Pixel 7',
      deviceType: 'MOBILE',
      browser: 'Chrome',
      operatingSystem: 'Android',
    });
    expect(history.country).toBeUndefined();
  });

  it('stores approximate IP location when the provider responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, country: 'United States', region: 'California', city: 'Mountain View' }),
    }));

    await recordLoginActivity('usr_geo', { ipAddress: '8.8.8.8', userAgent: '' });

    const history = await LoginHistory.findOne({ userId: 'usr_geo' });
    expect(history).toMatchObject({
      country: 'United States',
      state: 'California',
      city: 'Mountain View',
    });
  });
});
