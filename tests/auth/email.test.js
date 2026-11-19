// Tests email registration, email sign-in (also used by the admin panel) and social sign-in.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Profile } from '../../src/models/Profile.js';
import { User } from '../../src/models/User.js';
import { latestBirthDateForAge } from '../../src/utils/age.js';
import { useTestDatabase } from '../helpers/factories.js';

const app = createApp();
const validRegistration = {
  email: 'Sam@Example.com',
  password: 'correct-horse-battery',
  displayName: 'Sam',
  dateOfBirth: '1995-05-20',
  acceptedTermsVersion: '2026-01',
};

function isoUtc(date) {
  return date.toISOString().slice(0, 10);
}

function shiftIsoDay(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoUtc(date);
}

describe('POST /auth/register', () => {
  useTestDatabase();

  it('creates a USER account with a hashed password and returns an AuthResult', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validRegistration);
    expect(res.status).toBe(201);
    expect(res.body.data.isNewUser).toBe(true);
    expect(res.body.data.user).toMatchObject({ onboardingComplete: false, role: 'USER' });

    const user = await User.findById(res.body.data.user.id).select('+passwordHash');
    expect(user.email).toBe('sam@example.com');
    expect(user.passwordHash).not.toBe(validRegistration.password);
    expect(await bcrypt.compare(validRegistration.password, user.passwordHash)).toBe(true);
    expect(await Profile.exists({ userId: user._id })).toBeTruthy();
  });

  it('ignores a role sent by the client', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ ...validRegistration, role: 'ADMIN' });
    expect(res.body.data.user.role).toBe('USER');
  });

  it('rejects a duplicate email with CONFLICT', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegistration);
    const res = await request(app).post('/api/v1/auth/register').send(validRegistration);
    expect(res.status).toBe(409);
  });

  it('rejects under-18 members with ACCOUNT_INELIGIBLE', async () => {
    const year = new Date().getUTCFullYear() - 17;
    const res = await request(app).post('/api/v1/auth/register').send({ ...validRegistration, dateOfBirth: `${year}-01-01` });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INELIGIBLE');
  });

  it('accepts a member who turns exactly 18 today', async () => {
    const dateOfBirth = isoUtc(latestBirthDateForAge(18));
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegistration, email: 'exactly18@example.com', dateOfBirth });
    expect(res.status).toBe(201);
  });

  it('rejects a member one day under 18 with ACCOUNT_INELIGIBLE', async () => {
    const dateOfBirth = shiftIsoDay(isoUtc(latestBirthDateForAge(18)), 1);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegistration, email: 'under18@example.com', dateOfBirth });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INELIGIBLE');
  });

  it('rejects a future date of birth as INVALID', async () => {
    const dateOfBirth = shiftIsoDay(isoUtc(new Date()), 1);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegistration, email: 'future@example.com', dateOfBirth });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(expect.arrayContaining([{ field: 'dateOfBirth', reason: 'INVALID' }]));
  });

  it('accepts a leap-day DOB once the member is 18+', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegistration, email: 'leap@example.com', dateOfBirth: '2004-02-29' });
    expect(res.status).toBe(201);
  });

  it('validates every field', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'nope', password: 'short', displayName: '', dateOfBirth: '1990-02-30', acceptedTermsVersion: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((detail) => detail.field).sort()).toEqual(
      ['acceptedTermsVersion', 'dateOfBirth', 'displayName', 'email', 'password'].sort(),
    );
  });

  it('requires the current Terms version', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ ...validRegistration, acceptedTermsVersion: '2020-01' });
    expect(res.body.error.details).toEqual([{ field: 'acceptedTermsVersion', reason: 'NOT_CURRENT' }]);
  });
});

describe('POST /auth/login', () => {
  useTestDatabase();

  it('signs in with the right password', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegistration);
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'sam@example.com', password: validRegistration.password });
    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(false);
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
  });

  it('returns the staff role so the admin panel can check it', async () => {
    await User.create({ email: 'admin@example.test', role: 'ADMIN', passwordHash: await bcrypt.hash('admin-password-1', 4) });
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.test', password: 'admin-password-1' });
    expect(res.body.data.user.role).toBe('ADMIN');
  });

  it('gives the same 401 for a wrong email and a wrong password', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegistration);
    const wrongPassword = await request(app).post('/api/v1/auth/login').send({ email: 'sam@example.com', password: 'wrong-password-1' });
    const wrongEmail = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(wrongEmail.body.error.message);
  });

  it('cancels a pending account deletion on sign-in', async () => {
    const registered = await request(app).post('/api/v1/auth/register').send(validRegistration);
    const userId = registered.body.data.user.id;
    await User.updateOne({ _id: userId }, { $set: { deletion: { status: 'SCHEDULED', scheduledFor: new Date(Date.now() + 86400000) } } });
    await request(app).post('/api/v1/auth/login').send({ email: 'sam@example.com', password: validRegistration.password });
    expect((await User.findById(userId)).deletion.status).toBe('NONE');
  });
});

describe('POST /auth/social/:provider', () => {
  useTestDatabase();

  it.each(['apple', 'google'])('returns FEATURE_NOT_CONFIGURED for %s', async (provider) => {
    const res = await request(app).post(`/api/v1/auth/social/${provider}`).send({ idToken: 'token' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('FEATURE_NOT_CONFIGURED');
  });

  it('returns 404 for unknown providers', async () => {
    const res = await request(app).post('/api/v1/auth/social/facebook').send({ idToken: 'token' });
    expect(res.status).toBe(404);
  });

  it('validates the idToken', async () => {
    const res = await request(app).post('/api/v1/auth/social/google').send({});
    expect(res.status).toBe(400);
  });
});
