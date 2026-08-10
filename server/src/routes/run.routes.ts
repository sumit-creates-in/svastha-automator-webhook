import { Router } from 'express';
import { cancelRun, enqueueRun, queueDepth } from '../engine/queue';
import { getNodeDefinition } from '../engine/registry';
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

/**
 * Re-runs a workflow with the same trigger payload.
 *
 * Every failure mode returns a specific message. A silent no-op used to be
 * possible here: when the original trigger had been deleted the code fell back
 * to `nodes[0]`, and if that happened to be an action with nothing after it the
 * run finished instantly having done nothing at all.
 */
router.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const run = await Run.findById(req.params.id).lean();
    if (!run) throw AppError.notFound('That run no longer exists — it may have been cleared.');

    const workflow = await Workflow.findById(run.workflow);
    if (!workflow) {
      throw AppError.badRequest('The workflow this run belongs to has been deleted.');
    }

    const nodes = workflow.nodes as unknown as WorkflowNode[];
    if (nodes.length === 0) throw AppError.badRequest('That workflow has no steps to run.');

    const original = nodes.find((node) => node.id === run.trigger?.nodeId);
    const anyTrigger = nodes.find((node) => getNodeDefinition(node.type)?.group === 'trigger');
    const startNode = original ?? anyTrigger;

    if (!startNode) {
      throw AppError.badRequest(
        'That workflow no longer has a trigger, so there is nothing to run from. Open it and add one.',
      );
    }

    const isTrigger = getNodeDefinition(startNode.type)?.group === 'trigger';
    const hasSomethingAfter = (workflow.edges ?? []).some((edge) => edge.source === startNode.id);
    if (isTrigger && !hasSomethingAfter) {
      throw AppError.badRequest(
        `"${startNode.name}" has no steps connected after it, so running again would do nothing.`,
      );
    }

    const { runId } = await enqueueRun({
      workflow,
      triggerNode: startNode,
      payload: (run.trigger?.payload ?? {}) as Record<string, unknown>,
      mode: 'manual',
      startedBy: req.user!.id,
      // If the original trigger is gone we start at a different node, which must
      // itself execute rather than being treated as an already-fired trigger.
      executeStartNode: !isTrigger,
    });

    res.status(202).json({
      runId,
      workflowId: String(workflow._id),
      startedFrom: startNode.name,
      note: original ? undefined : `The original trigger was removed — started from "${startNode.name}".`,
    });
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
