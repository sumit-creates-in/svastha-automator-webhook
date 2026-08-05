import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.logging.level,
  transport: env.isProd
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
  base: undefined,
});

export type Logger = typeof logger;
