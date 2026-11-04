
import mongoose from 'mongoose';
import dns from 'node:dns';
import { env } from './env.js';

mongoose.set('strictQuery', true);

const CONNECTION_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

// Fix MongoDB SRV DNS resolution in local development.
if (env.nodeEnv === 'development') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

export async function connectDB(uri = env.mongodbUri, options = {}) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    ...options,
  });

  console.log(
    `[db] connected to ${mongoose.connection.host}/${mongoose.connection.name}`
  );

  return mongoose.connection;
}

export async function ensureIndexes() {
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init())
  );
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

export function getDbState() {
  return CONNECTION_STATES[mongoose.connection.readyState] ?? 'disconnected';
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}
