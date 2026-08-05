import { Router } from 'express';
import mongoose from 'mongoose';
import authRoutes from './auth.routes';
import connectionRoutes from './connection.routes';
import nodeRoutes from './node.routes';
import runRoutes from './run.routes';
import userRoutes from './user.routes';
import webhookRoutes from './webhook.routes';
import workflowRoutes from './workflow.routes';

const router = Router();

router.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded',
    database: states[mongoose.connection.readyState] ?? 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
    version: '1.0.0',
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/nodes', nodeRoutes);
router.use('/connections', connectionRoutes);
router.use('/workflows', workflowRoutes);
router.use('/runs', runRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
