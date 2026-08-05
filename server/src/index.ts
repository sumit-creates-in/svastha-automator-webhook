import argon2 from 'argon2';
import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './db/connect';
import { scheduler } from './engine/scheduler';
import { worker } from './engine/worker';
import { toErrorMessage } from './lib/errors';
import { logger } from './lib/logger';
import { User } from './models/User';

/** Creates the first account from env vars, so a fresh deploy is usable immediately. */
async function bootstrapOwner(): Promise<void> {
  if (!env.bootstrap.email || !env.bootstrap.password) return;
  const existing = await User.findOne({ email: env.bootstrap.email.toLowerCase() });
  if (existing) return;

  await User.create({
    email: env.bootstrap.email,
    name: env.bootstrap.name,
    role: 'owner',
    passwordHash: await argon2.hash(env.bootstrap.password),
  });
  logger.info({ email: env.bootstrap.email }, 'Bootstrap owner account created');
}

async function main(): Promise<void> {
  await connectDatabase();
  await bootstrapOwner();

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(
      { port: env.port, env: env.nodeEnv, appUrl: env.appUrl },
      'SVASTHA Automator is running',
    );
  });

  if (env.engine.enabled) {
    worker.start();
    scheduler.start();
  } else {
    logger.warn('Engine disabled — this instance serves the API only');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    scheduler.stop();
    await worker.stop();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: toErrorMessage(reason) }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  logger.error({ err: toErrorMessage(error) }, 'Failed to start');
  process.exit(1);
});
