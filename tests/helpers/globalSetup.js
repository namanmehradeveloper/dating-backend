// Starts one in-memory MongoDB for the whole test run, so tests never touch the local dating_cloud database.
// Uploaded test files go to tests/.uploads, which is deleted when the run ends.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const TEST_UPLOADS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.uploads');

// Starts a single-node in-memory replica set (needed for transaction tests) and shares its URI with
// test files through Vitest's `inject('mongoUri')`. The returned function stops it after the run.
export default async function setup(project) {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  project.provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet.stop();
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
  };
}
