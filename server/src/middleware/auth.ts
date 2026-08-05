import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { User, type UserRole } from '../models/User';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.svastha_token;
  return cookie;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw AppError.unauthorized();

    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;
    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) throw AppError.unauthorized('Account is disabled');

    req.user = {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
    };
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    next(AppError.unauthorized('Session expired — please sign in again'));
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}
