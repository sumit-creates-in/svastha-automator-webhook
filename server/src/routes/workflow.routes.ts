import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { env } from '../config/env';
import { getNodeDefinition, listNodeDefinitions } from '../engine/registry';
import { enqueueRun } from '../engine/queue';
import { removeWorkflowSchedules, syncWorkflowSchedules } from '../engine/scheduler';
import type { WorkflowNode } from '../engine/types';
import { AppError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { Job } from '../models/Job';
import { Run } from '../models/Run';
import { Workflow } from '../models/Workflow';

const router = Router();
router.use(requireAuth);

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  params: z.record(z.unknown()).default({}),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  onError: z.enum(['stop', 'continue']).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(10).optional(),
  waitBetweenTriesMs: z.number().int().min(0).max(60000).optional(),
});

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional().default('main'),
});

const workflowSchema = z.object({
  name: z.string().min(1, 'Give the workflow a name'),
  description: z.string().optional().default(''),
  active: z.boolean().optional(),
  nodes: z.array(nodeSchema).default([]),
  edges: z.array(edgeSchema).default([]),
  variables: z.record(z.unknown()).optional().default({}),
  tags: z.array(z.string()).optional().default([]),
  settings: z
    .object({
      timezone: z.string().optional(),
      saveSuccessfulRunData: z.boolean().optional(),
      saveFailedRunData: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
    })
    .optional(),
});

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

/** Structural checks surfaced in the editor before a workflow can be activated. */
export function validateWorkflow(nodes: WorkflowNode[], edges: Array<{ source: string; target: string }>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const triggers = nodes.filter((node) => getNodeDefinition(node.type)?.group === 'trigger');

  if (nodes.length === 0) {
    issues.push({ level: 'error', message: 'The workflow is empty — add a trigger to begin.' });
  }
  if (triggers.length === 0 && nodes.length > 0) {
    issues.push({ level: 'error', message: 'Add a trigger node (Webhook, Schedule or Manual).' });
  }

  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `Two steps are called "${node.name}". Names must be unique so expressions can reference them.`,
      });
    }
    names.add(node.name);

    const definition = getNodeDefinition(node.type);
    if (!definition) {
      issues.push({ level: 'error', nodeId: node.id, message: `Unknown step type "${node.type}".` });
      continue;
    }

    for (const property of definition.properties) {
      if (!property.required) continue;
      const value = (node.params ?? {})[property.name];
      if (value === undefined || value === null || value === '') {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `"${node.name}" needs ${property.label}.`,
        });
      }
    }

    if (definition.group !== 'trigger') {
      const hasIncoming = edges.some((edge) => edge.target === node.id);
      if (!hasIncoming) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: `"${node.name}" is not connected — it will never run.`,
        });
      }
    }
  }

  return issues;
}

function withWebhookUrls(workflow: any) {
  const json = typeof workflow.toJSON === 'function' ? workflow.toJSON() : workflow;
  const nodes = (json.nodes ?? []) as WorkflowNode[];
  const webhookUrls: Record<string, string> = {};
  for (const node of nodes) {
    if (node.type !== 'webhookTrigger') continue;
    const suffix = String((node.params as Record<string, unknown>)?.path ?? '').replace(/^\/+/, '');
    webhookUrls[node.id] = `${env.appUrl}/api/webhooks/${json.webhookId}${suffix ? `/${suffix}` : ''}`;
  }
  return { ...json, webhookUrls };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? '').trim();
    const filter: Record<string, unknown> = {};
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (req.query.active === 'true') filter.active = true;
    if (req.query.active === 'false') filter.active = false;

    const workflows = await Workflow.find(filter).sort({ updatedAt: -1 }).limit(200);
    res.json({ workflows: workflows.map(withWebhookUrls) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');
    res.json({
      workflow: withWebhookUrls(workflow),
      issues: validateWorkflow(
        workflow.nodes as unknown as WorkflowNode[],
        workflow.edges as unknown as Array<{ source: string; target: string }>,
      ),
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = workflowSchema.parse(req.body);
    const workflow = await Workflow.create({
      ...data,
      webhookId: nanoid(22),
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    });
    await syncWorkflowSchedules(workflow);
    res.status(201).json({ workflow: withWebhookUrls(workflow) });
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = workflowSchema.parse(req.body);
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');

    const issues = validateWorkflow(data.nodes as WorkflowNode[], data.edges);
    const blocking = issues.filter((issue) => issue.level === 'error');
    if (data.active && blocking.length > 0) {
      throw AppError.badRequest('Fix these problems before activating', blocking);
    }

    workflow.set({
      ...data,
      settings: { ...workflow.settings, ...(data.settings ?? {}) },
      updatedBy: req.user!.id,
    });
    if (!workflow.webhookId) workflow.set('webhookId', nanoid(22));
    await workflow.save();
    await syncWorkflowSchedules(workflow);

    res.json({ workflow: withWebhookUrls(workflow), issues });
  }),
);

router.patch(
  '/:id/active',
  asyncHandler(async (req, res) => {
    const active = Boolean(req.body?.active);
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');

    if (active) {
      const issues = validateWorkflow(
        workflow.nodes as unknown as WorkflowNode[],
        workflow.edges as unknown as Array<{ source: string; target: string }>,
      ).filter((issue) => issue.level === 'error');
      if (issues.length > 0) throw AppError.badRequest('Fix these problems before activating', issues);
    }

    workflow.set('active', active);
    await workflow.save();
    await syncWorkflowSchedules(workflow);
    res.json({ workflow: withWebhookUrls(workflow) });
  }),
);

router.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const source = await Workflow.findById(req.params.id).lean();
    if (!source) throw AppError.notFound('Workflow not found');

    const copy = await Workflow.create({
      name: `${source.name} (copy)`,
      description: source.description,
      nodes: source.nodes,
      edges: source.edges,
      variables: source.variables,
      settings: source.settings,
      tags: source.tags,
      active: false,
      webhookId: nanoid(22),
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    });

    res.status(201).json({ workflow: withWebhookUrls(copy) });
  }),
);

/** Manual / test execution from the editor. */
router.post(
  '/:id/run',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');

    const nodes = workflow.nodes as unknown as WorkflowNode[];
    const requestedNodeId = req.body?.triggerNodeId as string | undefined;

    const triggerNode = requestedNodeId
      ? nodes.find((node) => node.id === requestedNodeId)
      : nodes.find((node) => getNodeDefinition(node.type)?.group === 'trigger');

    if (!triggerNode) throw AppError.badRequest('This workflow has no trigger to start from');

    let payload: Record<string, unknown> = req.body?.payload ?? {};
    if (!req.body?.payload && triggerNode.type === 'manualTrigger') {
      const sample = (triggerNode.params as Record<string, unknown>)?.sampleData;
      if (typeof sample === 'string') {
        try {
          payload = JSON.parse(sample);
        } catch {
          payload = {};
        }
      } else if (sample && typeof sample === 'object') {
        payload = sample as Record<string, unknown>;
      }
    }

    const { runId } = await enqueueRun({
      workflow,
      triggerNode,
      payload,
      mode: 'test',
      startedBy: req.user!.id,
    });

    res.status(202).json({ runId });
  }),
);

router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit ?? 25));
    const runs = await Run.find({ workflow: req.params.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-steps');
    res.json({ runs: runs.map((run) => run.toJSON()) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');

    await Promise.all([
      Run.deleteMany({ workflow: workflow._id }),
      Job.deleteMany({ workflow: workflow._id }),
      removeWorkflowSchedules(String(workflow._id)),
    ]);
    await workflow.deleteOne();

    res.json({ ok: true });
  }),
);

/** Export / import so workflows can be version-controlled or shared. */
router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id).lean();
    if (!workflow) throw AppError.notFound('Workflow not found');
    res.json({
      svasthaVersion: 1,
      name: workflow.name,
      description: workflow.description,
      nodes: workflow.nodes,
      edges: workflow.edges,
      variables: workflow.variables,
      settings: workflow.settings,
      exportedAt: new Date().toISOString(),
    });
  }),
);

router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const data = workflowSchema.parse({ ...req.body, active: false });
    const workflow = await Workflow.create({
      ...data,
      active: false,
      webhookId: nanoid(22),
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    });
    res.status(201).json({ workflow: withWebhookUrls(workflow) });
  }),
);

/** Node catalogue used to build the palette and config forms. */
router.get('/meta/node-types', (_req, res) => {
  res.json({ nodes: listNodeDefinitions() });
});

export default router;
