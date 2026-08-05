import argon2 from 'argon2';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { AppError, asyncHandler } from '../lib/errors';
import { requireAuth, signToken } from '../middleware/auth';
import { User } from '../models/User';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes.' },
});

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const setupSchema = credentialsSchema.extend({
  name: z.string().min(1, 'Name is required'),
});

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

/** Tells the login screen whether the very first account still needs creating. */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const count = await User.estimatedDocumentCount();
    res.json({ needsSetup: count === 0, appName: 'SVASTHA Automator' });
  }),
);

/** First-run: creates the owner account. Disabled once any user exists. */
router.post(
  '/setup',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const count = await User.estimatedDocumentCount();
    if (count > 0) throw AppError.forbidden('Setup has already been completed');

    const { email, password, name } = setupSchema.parse(req.body);
    const user = await User.create({
      email,
      name,
      role: 'owner',
      passwordHash: await argon2.hash(password),
    });

    const token = signToken({ sub: String(user._id), email: user.email, role: 'owner' });
    res.cookie('svastha_token', token, cookieOptions());
    res.status(201).json({ token, user: user.toJSON() });
  }),
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);

    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    if (!user || !user.active) throw AppError.unauthorized('Email or password is incorrect');

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw AppError.unauthorized('Email or password is incorrect');

    user.set('lastLoginAt', new Date());
    await user.save();

    const token = signToken({
      sub: String(user._id),
      email: user.email,
      role: user.role as 'owner' | 'admin' | 'member',
    });
    res.cookie('svastha_token', token, cookieOptions());
    res.json({ token, user: user.toJSON() });
  }),
);

router.post('/logout', (_req, res) => {
  res.clearCookie('svastha_token', { path: '/' });
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id);
    if (!user) throw AppError.unauthorized();
    res.json({ user: user.toJSON() });
  }),
);

router.patch(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8, 'New password must be at least 8 characters'),
    });
    const { currentPassword, newPassword } = schema.parse(req.body);

    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user) throw AppError.unauthorized();

    const ok = await argon2.verify(user.passwordHash, currentPassword);
    if (!ok) throw AppError.badRequest('Current password is incorrect');

    user.set('passwordHash', await argon2.hash(newPassword));
    await user.save();
    res.json({ ok: true });
  }),
);

export default router;
