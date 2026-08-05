import { Router } from 'express';
import { cancelRun, enqueueRun, queueDepth } from '../engine/queue';
import type { WorkflowNode } from '../engine/types';
import { AppError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { Run } from '../models/Run';
import { Workflow } from '../models/Workflow';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit ?? 30));
    const page = Math.max(1, Number(req.query.page ?? 1));

    const filter: Record<string, unknown> = {};
    if (req.query.workflow) filter.workflow = req.query.workflow;
    if (req.query.status) filter.status = req.query.status;

    const [runs, total] = await Promise.all([
      Run.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-steps'),
      Run.countDocuments(filter),
    ]);

    res.json({ runs: runs.map((run) => run.toJSON()), total, page, limit });
  }),
);

/** Counters for the dashboard. */
router.get(
  '/stats/summary',
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [byStatus, total24h, workflows, activeWorkflows, depth] = await Promise.all([
      Run.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Run.countDocuments({ createdAt: { $gte: since } }),
      Workflow.countDocuments(),
      Workflow.countDocuments({ active: true }),
      queueDepth(),
    ]);

    const statuses: Record<string, number> = {};
    for (const row of byStatus) statuses[row._id as string] = row.count as number;

    res.json({
      last24h: { total: total24h, ...statuses },
      workflows,
      activeWorkflows,
      queue: depth,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const run = await Run.findById(req.params.id);
    if (!run) throw AppError.notFound('Run not found');
    res.json({ run: run.toJSON() });
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    await cancelRun(req.params.id);
    res.json({ ok: true });
  }),
);

/** Re-runs a workflow with the same trigger payload. */
router.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const run = await Run.findById(req.params.id).lean();
    if (!run) throw AppError.notFound('Run not found');

    const workflow = await Workflow.findById(run.workflow);
    if (!workflow) throw AppError.notFound('The workflow no longer exists');

    const nodes = workflow.nodes as unknown as WorkflowNode[];
    const triggerNode = nodes.find((node) => node.id === run.trigger?.nodeId) ?? nodes[0];
    if (!triggerNode) throw AppError.badRequest('This workflow has no trigger');

    const { runId } = await enqueueRun({
      workflow,
      triggerNode,
      payload: (run.trigger?.payload ?? {}) as Record<string, unknown>,
      mode: 'manual',
      startedBy: req.user!.id,
    });

    res.status(202).json({ runId });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await Run.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  }),
);

export default router;
