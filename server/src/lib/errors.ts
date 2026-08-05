import type { NextFunction, Request, Response } from 'express';

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, message, 'bad_request', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, message, 'unauthorized');
  }
  static forbidden(message = 'You do not have permission to do that') {
    return new AppError(403, message, 'forbidden');
  }
  static notFound(message = 'Not found') {
    return new AppError(404, message, 'not_found');
  }
  static conflict(message: string) {
    return new AppError(409, message, 'conflict');
  }
  static internal(message = 'Something went wrong') {
    return new AppError(500, message, 'internal_error');
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps an async route handler so rejected promises reach the error middleware. */
export const asyncHandler =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
