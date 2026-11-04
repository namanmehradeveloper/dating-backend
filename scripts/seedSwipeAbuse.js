// Seeds a high-volume swiper so /swipes → Abuse has at least one row to review.
// Run with: npm run seed:swipe-abuse

import { connectDB, disconnectDB } from '../src/config/db.js';
import { Profile } from '../src/models/Profile.js';
import { Swipe } from '../src/models/Swipe.js';
import { User } from '../src/models/User.js';
import { getSetting } from '../src/services/settings.service.js';

const ABUSER_PHONE = '+15552002001';
const TARGET_PHONE_PREFIX = '+1555201';

function birthDateForAge(age) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - age);
  return date;
}

async function ensureMember(phone, displayName) {
  let user = await User.findOne({ phoneNumber: phone });
  if (!user) {
    user = await User.create({ phoneNumber: phone, onboardingComplete: true, role: 'USER', status: 'ACTIVE' });
  }
  let profile = await Profile.findOne({ userId: user._id });
  if (!profile) {
    await Profile.create({
      userId: user._id,
      displayName,
      dateOfBirth: birthDateForAge(26),
      gender: 'MAN',
      showGender: true,
      relationshipGoal: 'LONG_TERM',
      interestIds: [],
      photos: [],
      acceptedTermsVersion: '2026-01',
      preferences: { minAge: 18, maxAge: 99, maxDistanceKm: 80, showMe: 'EVERYONE' },
    });
  }
  return user;
}

async function seedSwipeAbuse() {
  await connectDB();

  const threshold = Number(await getSetting('swipeAbuseThresholdPerDay')) || 80;
  const need = threshold + 5;
  const abuser = await ensureMember(ABUSER_PHONE, 'Swipe Abuser');

  const targets = [];
  for (let i = 0; i < need; i += 1) {
    const phone = `${TARGET_PHONE_PREFIX}${String(i).padStart(4, '0')}`;
    targets.push(await ensureMember(phone, `Target ${i + 1}`));
  }

  const actions = ['LIKE', 'PASS', 'SUPER_LIKE'];
  const now = Date.now();
  let created = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const existing = await Swipe.findOne({ userId: abuser._id, targetUserId: target._id });
    if (existing) {
      await Swipe.updateOne({ _id: existing._id }, { $set: { createdAt: new Date(now - i * 1000), action: actions[i % actions.length] } });
      continue;
    }
    await Swipe.create({
      userId: abuser._id,
      targetUserId: target._id,
      action: actions[i % actions.length],
      createdAt: new Date(now - i * 1000),
    });
    created += 1;
  }

  const swipeCount = await Swipe.countDocuments({
    userId: abuser._id,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  console.log(`Abuser ${abuser._id} (${ABUSER_PHONE}) has ${swipeCount} swipes in 24h (threshold ${threshold}).`);
  console.log(`Inserted ${created} new swipe(s). Open /swipes → Abuse.`);
  await disconnectDB();
}

seedSwipeAbuse().catch(async (error) => {
  console.error('Could not seed swipe abuse data:', error.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
