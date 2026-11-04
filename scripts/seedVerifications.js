// Seeds a few selfie verification requests so the admin /verifications table has rows to review.
// Run with: npm run seed:verifications

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Media } from '../src/models/Media.js';
import { Profile } from '../src/models/Profile.js';
import { User } from '../src/models/User.js';
import { VerificationRequest } from '../src/models/VerificationRequest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../uploads/verification');

const SAMPLES = [
  { phone: '+15551001001', displayName: 'Aisha Khan', status: 'PENDING' },
  { phone: '+15551001002', displayName: 'Rohan Mehta', status: 'PENDING' },
  { phone: '+15551001003', displayName: 'Priya Shah', status: 'APPROVED' },
  { phone: '+15551001004', displayName: 'Dev Patel', status: 'REJECTED', reason: 'Face not clearly visible' },
];

function birthDateForAge(age) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - age);
  return date;
}

async function writePlaceholderJpeg(filePath, tint) {
  const buffer = await sharp({
    create: { width: 320, height: 400, channels: 3, background: tint },
  })
    .jpeg()
    .toBuffer();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return buffer.length;
}

async function ensureMember(sample) {
  let user = await User.findOne({ phoneNumber: sample.phone });
  if (!user) {
    user = await User.create({
      phoneNumber: sample.phone,
      onboardingComplete: true,
      verificationStatus: sample.status === 'APPROVED' ? 'VERIFIED' : sample.status === 'REJECTED' ? 'REJECTED' : 'PENDING',
    });
  } else {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          verificationStatus: sample.status === 'APPROVED' ? 'VERIFIED' : sample.status === 'REJECTED' ? 'REJECTED' : 'PENDING',
        },
      },
    );
  }

  let profile = await Profile.findOne({ userId: user._id });
  if (!profile) {
    profile = await Profile.create({
      userId: user._id,
      displayName: sample.displayName,
      dateOfBirth: birthDateForAge(27),
      gender: 'WOMAN',
      showGender: true,
      relationshipGoal: 'LONG_TERM',
      interestIds: [],
      photos: [],
      acceptedTermsVersion: '2026-01',
      preferences: { minAge: 18, maxAge: 99, maxDistanceKm: 80, showMe: 'EVERYONE' },
    });
  } else if (profile.displayName !== sample.displayName) {
    await Profile.updateOne({ _id: profile._id }, { $set: { displayName: sample.displayName } });
  }

  return user;
}

async function ensureVerification(user, sample) {
  const existing = await VerificationRequest.findOne({ userId: user._id, status: sample.status }).sort({ createdAt: -1 });
  if (existing) return { created: false, id: existing._id };

  const fileName = `${user._id}_${Date.now()}_seed.jpg`;
  const relativePath = `/uploads/verification/${fileName}`;
  const absolutePath = path.join(UPLOADS_DIR, fileName);
  const sizeBytes = await writePlaceholderJpeg(absolutePath, {
    r: 40 + Math.floor(Math.random() * 180),
    g: 60 + Math.floor(Math.random() * 120),
    b: 90 + Math.floor(Math.random() * 120),
  });

  const selfie = await Media.create({
    ownerId: user._id,
    purpose: 'VERIFICATION_SELFIE',
    status: 'APPROVED',
    contentType: 'image/jpeg',
    sizeBytes,
    width: 320,
    height: 400,
    relativePath,
  });

  const reviewedAt = sample.status === 'PENDING' ? undefined : new Date();
  const request = await VerificationRequest.create({
    userId: user._id,
    selfieMediaId: selfie._id,
    status: sample.status,
    reason: sample.reason,
    reviewedAt,
  });

  return { created: true, id: request._id };
}

async function seedVerifications() {
  await connectDB();
  let created = 0;

  for (const sample of SAMPLES) {
    const user = await ensureMember(sample);
    const result = await ensureVerification(user, sample);
    if (result.created) created += 1;
    console.log(`${result.created ? 'Created' : 'Kept'} ${sample.status} verification for ${sample.displayName} (${result.id})`);
  }

  console.log(`Done. ${created} new verification request(s). Open /verifications in the admin panel.`);
  await disconnectDB();
}

seedVerifications().catch(async (error) => {
  console.error('Could not seed verifications:', error.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
