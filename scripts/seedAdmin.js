// Creates (or resets) the Super Admin account from ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env.
// Run with: npm run seed:admin. Super Admin cannot be created from the staff panel.

import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { BCRYPT_ROUNDS } from '../src/services/auth.service.js';
import { checkEmail } from '../src/validators/common.js';

const MIN_PASSWORD_LENGTH = 10;

// Reads and checks the admin credentials from the environment. Exits with a message when invalid.
function readAdminCredentials() {
  const details = [];
  const email = checkEmail(details, process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email) {
    console.error('Set ADMIN_EMAIL in backend/.env to a valid email address.');
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128 || password.startsWith('change_this')) {
    console.error(`Set ADMIN_PASSWORD in backend/.env to your own password (${MIN_PASSWORD_LENGTH}–128 characters).`);
    process.exit(1);
  }
  return { email, password };
}

// Creates the admin, or promotes/resets the existing account with that email.
async function seedAdmin() {
  const { email, password } = readAdminCredentials();
  await connectDB();

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const existing = await User.findOne({ email });
  await User.updateOne(
    { email },
    { $set: { passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE', onboardingComplete: true }, $setOnInsert: { email } },
    { upsert: true },
  );

  console.log(existing ? `Updated Super Admin account ${email}.` : `Created Super Admin account ${email}.`);
  await disconnectDB();
}

seedAdmin().catch(async (error) => {
  console.error('Could not seed the admin account:', error.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
