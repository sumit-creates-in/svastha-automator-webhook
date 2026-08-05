import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri = env.mongoUri): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}
