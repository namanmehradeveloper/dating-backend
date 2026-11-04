// Database helpers for tests: each test file gets its own throwaway database on the in-memory server.

import mongoose from 'mongoose';
import { inject } from 'vitest';
import { connectDB, disconnectDB, ensureIndexes } from '../../src/config/db.js';
import '../../src/models/index.js';

// Connects this test file to a new, uniquely named database (with its indexes built) so files never share data.
export async function connectTestDb() {
  const suffix = `${process.env.VITEST_POOL_ID ?? '0'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await connectDB(inject('mongoUri'), { dbName: `test_${suffix}` });
  await ensureIndexes();
}

// Deletes all documents from every collection, used to reset state between tests.
export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

// Drops this file's database and disconnects.
export async function closeTestDb() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await disconnectDB();
}
