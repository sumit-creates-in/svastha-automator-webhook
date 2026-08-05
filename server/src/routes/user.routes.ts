import argon2 from 'argon2';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { User, USER_ROLES } from '../models/User';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await User.find().sort({ createdAt: 1 });
    res.json({ users: users.map((user) => user.toJSON()) });
  }),
);

router.post(
  '/',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(1),
      password: z.string().min(8, 'Password must be at least 8 characters'),
      role: z.enum(USER_ROLES).default('member'),
    });
    const data = schema.parse(req.body);

    const exists = await User.findOne({ email: data.email.toLowerCase() });
    if (exists) throw AppError.conflict('A user with that email already exists');

    const user = await User.create({
      email: data.email,
      name: data.name,
      role: data.role,
      passwordHash: await argon2.hash(data.password),
    });

    res.status(201).json({ user: user.toJSON() });
  }),
);

router.patch(
  '/:id',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      role: z.enum(USER_ROLES).optional(),
      active: z.boolean().optional(),
      password: z.string().min(8).optional(),
    });
    const data = schema.parse(req.body);

    const user = await User.findById(req.params.id);
    if (!user) throw AppError.notFound('User not found');

    if (user.role === 'owner' && req.user!.role !== 'owner') {
      throw AppError.forbidden('Only the owner can change the owner account');
    }

    if (data.name) user.set('name', data.name);
    if (data.role) user.set('role', data.role);
    if (data.active !== undefined) user.set('active', data.active);
    if (data.password) user.set('passwordHash', await argon2.hash(data.password));

    await user.save();
    res.json({ user: user.toJSON() });
  }),
);

router.delete(
  '/:id',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.id) throw AppError.badRequest('You cannot delete yourself');
    const user = await User.findById(req.params.id);
    if (!user) throw AppError.notFound('User not found');
    if (user.role === 'owner') throw AppError.badRequest('The owner account cannot be deleted');
    await user.deleteOne();
    res.json({ ok: true });
  }),
);

export default router;
