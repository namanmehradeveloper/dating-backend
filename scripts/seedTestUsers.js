// Seeds the 25 fictional test members from the CSV (dummy profile photos).
// Run with: npm run seed:test-users

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Media } from '../src/models/Media.js';
import { Profile } from '../src/models/Profile.js';
import { User } from '../src/models/User.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../uploads/profile');

const CITY_COORDS = {
  Jaipur: [75.7873, 26.9124],
  Delhi: [77.209, 28.6139],
  Mumbai: [72.8777, 19.076],
  Bengaluru: [77.5946, 12.9716],
  Pune: [73.8567, 18.5204],
  Hyderabad: [78.4867, 17.385],
  Udaipur: [73.7125, 24.5854],
  Ahmedabad: [72.5714, 23.0225],
  Indore: [75.8577, 22.7196],
  Lucknow: [80.9462, 26.8467],
  Chandigarh: [76.7794, 30.7333],
  Gurugram: [77.0266, 28.4595],
  Noida: [77.391, 28.5355],
  Kanpur: [80.3319, 26.4499],
  Bhopal: [77.4126, 23.2599],
  Kolkata: [88.3639, 22.5726],
  Nagpur: [79.0882, 21.1458],
  Dehradun: [78.0322, 30.3165],
  Amritsar: [74.8723, 31.634],
  Surat: [72.8311, 21.1702],
  Raipur: [81.6296, 21.2514],
  Varanasi: [82.9739, 25.3176],
};

const USERS = [
  {
    phone: '+919876543210',
    displayName: 'Aarav Sharma',
    dateOfBirth: '1997-03-15',
    gender: 'MAN',
    showGender: true,
    showMe: 'EVERYONE',
    city: 'Jaipur',
    occupation: 'Software Engineer',
    bio: 'Techie, traveler and a coffee lover. Looking for a serious and honest partner.',
  },
  {
    phone: '+919876543211',
    displayName: 'Simran Kaur',
    dateOfBirth: '1998-07-22',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Jaipur',
    occupation: 'Marketing Executive',
    bio: 'Optimistic, family oriented and love exploring new places.',
  },
  {
    phone: '+919876543212',
    displayName: 'Rohan Mehta',
    dateOfBirth: '1996-10-10',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Delhi',
    occupation: 'Business Analyst',
    bio: 'Work hard, travel often and believe in meaningful connections.',
  },
  {
    phone: '+919876543213',
    displayName: 'Priya Verma',
    dateOfBirth: '1996-05-05',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Mumbai',
    occupation: 'HR Associate',
    bio: 'Simple, caring and value honesty in a relationship.',
  },
  {
    phone: '+919876543214',
    displayName: 'Kunal Singh',
    dateOfBirth: '1995-09-18',
    gender: 'MAN',
    showGender: false,
    showMe: 'EVERYONE',
    city: 'Bengaluru',
    occupation: 'Product Manager',
    bio: 'Fitness, gadgets and travel are my things. Looking for a like-minded partner.',
  },
  {
    phone: '+919876543215',
    displayName: 'Neha Gupta',
    dateOfBirth: '1998-12-12',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Pune',
    occupation: 'Content Creator',
    bio: 'Creative, foodie and always up for new adventures.',
  },
  {
    phone: '+919876543216',
    displayName: 'Aditya Joshi',
    dateOfBirth: '1997-04-19',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Hyderabad',
    occupation: 'Data Engineer',
    bio: 'Data geek, movie buff and a big fan of weekend getaways.',
  },
  {
    phone: '+919876543217',
    displayName: 'Pooja Rathore',
    dateOfBirth: '1999-06-30',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Udaipur',
    occupation: 'Teacher',
    bio: 'Love teaching, reading and spending time with family.',
  },
  {
    phone: '+919876543218',
    displayName: 'Vikram Choudhary',
    dateOfBirth: '1996-11-07',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Ahmedabad',
    occupation: 'Civil Engineer',
    bio: 'Down to earth, nature lover and a big believer in loyalty.',
  },
  {
    phone: '+919876543219',
    displayName: 'Ishita Bansal',
    dateOfBirth: '2000-02-16',
    gender: 'WOMAN',
    showGender: false,
    showMe: 'MEN',
    city: 'Indore',
    occupation: 'Graphic Designer',
    bio: 'Design, music and travel keep me happy. Looking for a genuine match.',
  },
  {
    phone: '+919876543220',
    displayName: 'Manish Yadav',
    dateOfBirth: '1994-05-08',
    gender: 'MAN',
    showGender: true,
    showMe: 'EVERYONE',
    city: 'Lucknow',
    occupation: 'Operations Manager',
    bio: 'Responsible, calm and family oriented. Believe in long-term relationships.',
  },
  {
    phone: '+919876543221',
    displayName: 'Ritika Soni',
    dateOfBirth: '1998-10-21',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Chandigarh',
    occupation: 'Fashion Designer',
    bio: "Fashion, travel and good conversations – that's me!",
  },
  {
    phone: '+919876543222',
    displayName: 'Nikhil Arora',
    dateOfBirth: '1997-03-03',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Gurugram',
    occupation: 'IT Consultant',
    bio: 'Work, fitness and travel help me stay balanced. Looking for someone real.',
  },
  {
    phone: '+919876543223',
    displayName: 'Ananya Jain',
    dateOfBirth: '1999-08-27',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Noida',
    occupation: 'Business Executive',
    bio: "Ambitious, kind and a big foodie. Let's create a beautiful story together.",
  },
  {
    phone: '+919876543224',
    displayName: 'Harshit Rastogi',
    dateOfBirth: '1996-01-11',
    gender: 'MAN',
    showGender: false,
    showMe: 'WOMEN',
    city: 'Kanpur',
    occupation: 'Chartered Accountant',
    bio: 'Finance professional, gym lover and a simple person at heart.',
  },
  {
    phone: '+919876543225',
    displayName: 'Meera Joshi',
    dateOfBirth: '1998-04-04',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Bhopal',
    occupation: 'Nurse',
    bio: 'Caring, empathetic and love helping people. Looking for a life partner.',
  },
  {
    phone: '+919876543226',
    displayName: 'Saurabh Malik',
    dateOfBirth: '1995-12-25',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Jaipur',
    occupation: 'Sales Manager',
    bio: 'Energetic, social and always up for a good conversation.',
  },
  {
    phone: '+919876543227',
    displayName: 'Kavya Sharma',
    dateOfBirth: '1999-09-14',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Delhi',
    occupation: 'Digital Marketer',
    bio: "Marketing by profession, exploring by passion. Let's connect!",
  },
  {
    phone: '+919876543228',
    displayName: 'Arjun Verma',
    dateOfBirth: '1998-07-02',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Kolkata',
    occupation: 'Software Developer',
    bio: 'Coder by day, traveler by heart. Looking for a meaningful relationship.',
  },
  {
    phone: '+919876543229',
    displayName: 'Sneha Patil',
    dateOfBirth: '1998-11-18',
    gender: 'WOMAN',
    showGender: false,
    showMe: 'MEN',
    city: 'Nagpur',
    occupation: 'Physiotherapist',
    bio: 'Health, fitness and a positive lifestyle. Value honesty and respect.',
  },
  {
    phone: '+919876543230',
    displayName: 'Deepak Rawat',
    dateOfBirth: '1994-02-09',
    gender: 'MAN',
    showGender: true,
    showMe: 'EVERYONE',
    city: 'Dehradun',
    occupation: 'Government Employee',
    bio: 'Nature lover, disciplined and family oriented.',
  },
  {
    phone: '+919876543231',
    displayName: 'Tanya Oberoi',
    dateOfBirth: '1998-06-06',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Amritsar',
    occupation: 'Event Manager',
    bio: 'Love planning events, meeting new people and making memories.',
  },
  {
    phone: '+919876543232',
    displayName: 'Raghav Bhatia',
    dateOfBirth: '1996-09-17',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Surat',
    occupation: 'Entrepreneur',
    bio: 'Running my own business, love travel and good company.',
  },
  {
    phone: '+919876543233',
    displayName: 'Nidhi Chauhan',
    dateOfBirth: '1999-05-29',
    gender: 'WOMAN',
    showGender: true,
    showMe: 'MEN',
    city: 'Raipur',
    occupation: 'Bank Officer',
    bio: 'Simple, career focused and value meaningful bonds.',
  },
  {
    phone: '+919876543234',
    displayName: 'Aman Saxena',
    dateOfBirth: '1995-03-29',
    gender: 'MAN',
    showGender: true,
    showMe: 'WOMEN',
    city: 'Varanasi',
    occupation: 'IT Project Lead',
    bio: 'Tech professional, cricket fan and a big-time traveler. Looking for my perfect match.',
  },
];

function tintFor(index, photoIndex) {
  const hues = [
    { r: 52, g: 98, b: 140 },
    { r: 140, g: 72, b: 98 },
    { r: 72, g: 120, b: 88 },
    { r: 120, g: 90, b: 60 },
    { r: 90, g: 70, b: 130 },
  ];
  const base = hues[(index + photoIndex) % hues.length];
  return {
    r: Math.min(255, base.r + ((index * 11) % 40)),
    g: Math.min(255, base.g + ((index * 7) % 35)),
    b: Math.min(255, base.b + ((index * 13) % 45)),
  };
}

async function writePlaceholderJpeg(filePath, tint, label) {
  const svg = Buffer.from(`
    <svg width="640" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="800" fill="rgb(${tint.r},${tint.g},${tint.b})"/>
      <text x="50%" y="48%" text-anchor="middle" fill="white" font-size="36" font-family="Arial, sans-serif">${label}</text>
      <text x="50%" y="56%" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="22" font-family="Arial, sans-serif">Dummy photo</text>
    </svg>
  `);
  const buffer = await sharp(svg).jpeg({ quality: 80 }).toBuffer();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { sizeBytes: buffer.length, width: 640, height: 800 };
}

async function ensureDummyPhotos(user, sample, userIndex) {
  const profile = await Profile.findOne({ userId: user._id });
  if (!profile) return 0;
  if (profile.photos?.length >= 2) return 0;

  const photos = [];
  for (let photoIndex = 0; photoIndex < 2; photoIndex += 1) {
    const fileName = `${user._id}_${Date.now()}_${photoIndex}_seed.jpg`;
    const relativePath = `/uploads/profile/${fileName}`;
    const absolutePath = path.join(UPLOADS_DIR, fileName);
    const meta = await writePlaceholderJpeg(
      absolutePath,
      tintFor(userIndex, photoIndex),
      sample.displayName.split(' ')[0],
    );

    const media = await Media.create({
      ownerId: user._id,
      purpose: 'PROFILE_PHOTO',
      status: 'APPROVED',
      contentType: 'image/jpeg',
      sizeBytes: meta.sizeBytes,
      width: meta.width,
      height: meta.height,
      relativePath,
    });

    photos.push({
      mediaId: media._id,
      relativePath,
      order: photoIndex,
      moderationStatus: 'APPROVED',
    });
  }

  await Profile.updateOne({ userId: user._id }, { $set: { photos } });
  return photos.length;
}

function locationFor(city) {
  const coords = CITY_COORDS[city];
  if (!coords) return undefined;
  return { type: 'Point', coordinates: coords };
}

async function ensureMember(sample, index) {
  let user = await User.findOne({ phoneNumber: sample.phone });
  let createdUser = false;
  if (!user) {
    user = await User.create({
      phoneNumber: sample.phone,
      role: 'USER',
      status: 'ACTIVE',
      onboardingComplete: true,
      verificationStatus: 'NONE',
    });
    createdUser = true;
  } else {
    await User.updateOne(
      { _id: user._id },
      { $set: { role: 'USER', status: 'ACTIVE', onboardingComplete: true } },
    );
  }

  const profileFields = {
    displayName: sample.displayName,
    dateOfBirth: new Date(`${sample.dateOfBirth}T00:00:00.000Z`),
    gender: sample.gender,
    showGender: sample.showGender,
    relationshipGoal: 'LONG_TERM',
    bio: sample.bio,
    city: sample.city,
    occupation: sample.occupation,
    interestIds: [],
    visibilityStatus: 'VISIBLE',
    acceptedTermsVersion: '2026-01',
    acceptedTermsAt: new Date(),
    preferences: {
      minAge: 18,
      maxAge: 99,
      maxDistanceKm: 50,
      showMe: sample.showMe,
    },
    ...(locationFor(sample.city) ? { location: locationFor(sample.city) } : {}),
  };

  let profile = await Profile.findOne({ userId: user._id });
  let createdProfile = false;
  if (!profile) {
    profile = await Profile.create({
      userId: user._id,
      photos: [],
      ...profileFields,
    });
    createdProfile = true;
  } else {
    await Profile.updateOne(
      { userId: user._id },
      {
        $set: profileFields,
      },
    );
  }

  const photosAdded = await ensureDummyPhotos(user, sample, index);
  return { createdUser, createdProfile, photosAdded, userId: user._id };
}

async function seedTestUsers() {
  await connectDB();
  let created = 0;
  let updated = 0;
  let photos = 0;

  for (let index = 0; index < USERS.length; index += 1) {
    const sample = USERS[index];
    const result = await ensureMember(sample, index);
    if (result.createdUser || result.createdProfile) created += 1;
    else updated += 1;
    photos += result.photosAdded;
    console.log(
      `${result.createdUser ? 'Created' : 'Updated'} ${sample.displayName} (${sample.phone}) → ${result.userId}` +
        (result.photosAdded ? ` +${result.photosAdded} dummy photos` : ''),
    );
  }

  console.log(`Done. ${created} created, ${updated} updated, ${photos} dummy photos written.`);
  console.log('Replace uploads/profile/*_seed.jpg later with real photos if needed.');
  await disconnectDB();
}

seedTestUsers().catch(async (error) => {
  console.error('Could not seed test users:', error.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
