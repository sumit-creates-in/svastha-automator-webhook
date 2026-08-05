import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const isProd = (process.env.NODE_ENV ?? 'development') === 'production';

/**
 * In development we fall back to throwaway secrets so the app boots with zero setup.
 * In production every secret must be supplied explicitly.
 */
const devSecret = 'svastha-dev-secret-change-me-0123456789abcdef';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,
  port: num('PORT', 8080),

  mongoUri: required('MONGODB_URI', isProd ? undefined : 'mongodb://127.0.0.1:27017/svastha_automator'),

  jwtSecret: required('JWT_SECRET', isProd ? undefined : devSecret),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  /** 32-byte key (hex or utf8) used for AES-256-GCM encryption of stored credentials. */
  encryptionKey: required('ENCRYPTION_KEY', isProd ? undefined : devSecret),

  /** Public base URL, used to render webhook URLs in the UI. */
  appUrl: (process.env.APP_URL ?? `http://localhost:${num('PORT', 8080)}`).replace(/\/$/, ''),

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  bootstrap: {
    email: process.env.BOOTSTRAP_EMAIL ?? '',
    password: process.env.BOOTSTRAP_PASSWORD ?? '',
    name: process.env.BOOTSTRAP_NAME ?? 'Owner',
  },

  engine: {
    /** Enable the in-process worker + scheduler. Disable to run a dedicated worker service. */
    enabled: bool('ENGINE_ENABLED', true),
    /** How many runs this instance executes at the same time. */
    concurrency: num('ENGINE_CONCURRENCY', 5),
    /** How often the worker polls MongoDB for due jobs (ms). */
    pollIntervalMs: num('ENGINE_POLL_INTERVAL_MS', 1000),
    /** Hard ceiling for a single workflow run (ms). */
    runTimeoutMs: num('ENGINE_RUN_TIMEOUT_MS', 5 * 60 * 1000),
    /** Timeout applied to each Code node execution (ms). */
    codeTimeoutMs: num('ENGINE_CODE_TIMEOUT_MS', 5000),
    /** Longest a job may be locked before it is considered stalled and reclaimed (ms). */
    stalledAfterMs: num('ENGINE_STALLED_AFTER_MS', 10 * 60 * 1000),
    /** Delay <= this value is awaited inline instead of being re-queued (ms). */
    inlineDelayMs: num('ENGINE_INLINE_DELAY_MS', 3000),
  },

  logging: {
    level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  },

  retention: {
    /** Days of run history to keep. 0 disables automatic cleanup. */
    runDays: num('RUN_RETENTION_DAYS', 30),
  },
} as const;

export type Env = typeof env;
