import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api')) {
    next(AppError.notFound(`No route for ${req.method} ${req.path}`));
    return;
  }
  next();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Some fields need attention',
      code: 'validation_error',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  // Duplicate key
  if (typeof error === 'object' && error && (error as { code?: number }).code === 11000) {
    res.status(409).json({ error: 'That name is already in use', code: 'conflict' });
    return;
  }

  logger.error({ err: error }, 'Unhandled error');
  res.status(500).json({ error: message, code: 'internal_error' });
}
