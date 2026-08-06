import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { env } from '../config/env';
import {
  buildFieldGroup,
  nodeRootExpression,
  summariseForSample,
  type FieldGroup,
} from '../engine/fields';
import { getNodeDefinition, listNodeDefinitions } from '../engine/registry';
import { enqueueRun } from '../engine/queue';
import { getTemplate, workflowTemplates } from '../engine/templates';
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
  pinnedData: z.unknown().optional(),
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
  targetHandle: z.string().optional().default('main'),
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
      captureSampleData: z.boolean().optional(),
      errorWorkflow: z.string().nullish(),
      errorEmailTo: z.string().optional(),
      errorEmailConnection: z.string().nullish(),
    })
    .optional(),
});

/**
 * Every step that can reach `nodeId`, plus the one immediately before it.
 *
 * The direct parent matters because that is the only step addressable as
 * `$json` — everything earlier needs `$node["Name"].json`.
 */
export function collectAncestors(
  nodeId: string,
  edges: Array<{ source: string; target: string }>,
): { all: string[]; direct?: string } {
  const parentsOf = (id: string) =>
    edges.filter((edge) => edge.target === id).map((edge) => edge.source);

  const direct = parentsOf(nodeId)[0];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const stack = [...parentsOf(nodeId)];

  while (stack.length > 0) {
    const current = stack.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    stack.push(...parentsOf(current));
  }

  // Nearest first, so the most relevant fields appear at the top of the panel.
  return { all: ordered, direct };
}

/** The output a step produced the last time it ran successfully. */
async function lastRecordedOutput(
  workflowId: string,
  nodeId?: string,
): Promise<unknown | undefined> {
  if (!nodeId) return undefined;
  const run = await Run.findOne({ workflow: workflowId, 'steps.nodeId': nodeId })
    .sort({ createdAt: -1 })
    .lean();
  return run?.steps?.filter((step) => step.nodeId === nodeId && step.status === 'success').at(-1)
    ?.output;
}

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

    // "Run from here": start mid-graph using pinned data or the captured payload,
    // so you can iterate on step 5 without replaying steps 1–4.
    if (req.body?.startFromNodeId) {
      const startNode = nodes.find((node) => node.id === req.body.startFromNodeId);
      if (!startNode) throw AppError.badRequest('That step is no longer in the workflow');

      const upstream = collectAncestors(startNode.id, workflow.edges as never).direct;
      const upstreamNode = nodes.find((node) => node.id === upstream);

      const seed =
        req.body?.payload ??
        upstreamNode?.pinnedData ??
        (await lastRecordedOutput(String(workflow._id), upstream)) ??
        workflow.sampleData?.payload ??
        {};

      const { runId } = await enqueueRun({
        workflow,
        triggerNode: startNode,
        payload: seed as Record<string, unknown>,
        mode: 'test',
        startedBy: req.user!.id,
      });

      res.status(202).json({ runId, startedFrom: startNode.name });
      return;
    }

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

/**
 * Fields available to a given step.
 *
 * Walks backwards from the step to find everything that could legitimately feed
 * it: the captured trigger payload, any pinned samples, and the recorded output
 * of each upstream step from the most recent run. Each entry carries the exact
 * expression needed to reference it.
 */
router.get(
  '/:id/fields',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id).lean();
    if (!workflow) throw AppError.notFound('Workflow not found');

    const nodes = (workflow.nodes ?? []) as unknown as WorkflowNode[];
    const edges = (workflow.edges ?? []) as unknown as Array<{ source: string; target: string }>;
    const nodeId = String(req.query.nodeId ?? '');
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const ancestors = collectAncestors(nodeId, edges);
    const groups: FieldGroup[] = [];

    // 1. The trigger payload — the thing people reference most.
    const triggerNode =
      nodes.find((node) => node.id === workflow.sampleData?.nodeId) ??
      nodes.find((node) => getNodeDefinition(node.type)?.group === 'trigger');

    const pinnedTrigger = triggerNode?.pinnedData;
    const capturedTrigger = workflow.sampleData?.payload;
    const triggerSample = pinnedTrigger ?? capturedTrigger;

    if (triggerNode) {
      const isDirectParent = ancestors.direct === triggerNode.id;
      groups.push(
        buildFieldGroup({
          key: 'trigger',
          label: triggerNode.name,
          description:
            getNodeDefinition(triggerNode.type)?.displayName ?? 'Trigger',
          // If the trigger feeds this step directly, $json is the natural form.
          root: isDirectParent ? '$json' : '$trigger',
          value: triggerSample,
          source: pinnedTrigger ? 'pinned' : capturedTrigger ? 'run' : 'none',
          capturedAt: workflow.sampleData?.capturedAt ?? undefined,
        }),
      );

      // $trigger always works, so offer it too when the trigger is further back.
      if (isDirectParent && triggerSample) {
        groups.push(
          buildFieldGroup({
            key: 'trigger-absolute',
            label: `${triggerNode.name} (via $trigger)`,
            description: 'Works from anywhere in the workflow',
            root: '$trigger',
            value: triggerSample,
            source: pinnedTrigger ? 'pinned' : 'run',
            capturedAt: workflow.sampleData?.capturedAt ?? undefined,
          }),
        );
      }
    }

    // 2. Outputs of upstream steps, taken from the latest run that reached them.
    const latestRun = await Run.findOne({
      workflow: workflow._id,
      'steps.0': { $exists: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    for (const ancestorId of ancestors.all) {
      const node = nodeById.get(ancestorId);
      if (!node || node.id === triggerNode?.id) continue;

      const recorded = latestRun?.steps
        ?.filter((step) => step.nodeId === node.id && step.status === 'success')
        .at(-1)?.output;

      const value = node.pinnedData ?? recorded;
      if (value === undefined || value === null) continue;

      groups.push(
        buildFieldGroup({
          key: node.id,
          label: node.name,
          description: getNodeDefinition(node.type)?.displayName,
          root:
            ancestors.direct === node.id ? '$json' : nodeRootExpression(node.name),
          value,
          source: node.pinnedData ? 'pinned' : 'run',
          capturedAt: latestRun?.createdAt as Date | undefined,
        }),
      );
    }

    res.json({
      groups: groups.filter((group) => group.fields.length > 0 || group.key === 'trigger'),
      hasSample: groups.some((group) => group.fields.length > 0),
      helpers: [
        { expression: '{{ $now }}', description: 'Current date and time' },
        { expression: '{{ $runId }}', description: 'Id of this run' },
        { expression: '{{ $workflowName }}', description: 'Name of this workflow' },
        { expression: '{{ $itemIndex }}', description: 'Position inside a Loop branch' },
      ],
    });
  }),
);

/** Saves or clears the pinned sample output for one step. */
router.patch(
  '/:id/nodes/:nodeId/pin',
  asyncHandler(async (req, res) => {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) throw AppError.notFound('Workflow not found');

    const nodes = workflow.nodes as unknown as WorkflowNode[];
    const node = nodes.find((entry) => entry.id === req.params.nodeId);
    if (!node) throw AppError.notFound('Step not found');

    const { data } = req.body ?? {};
    let parsed: unknown = data;
    if (typeof data === 'string') {
      if (data.trim() === '') {
        parsed = undefined;
      } else {
        try {
          parsed = JSON.parse(data);
        } catch {
          throw AppError.badRequest('That is not valid JSON. Paste an object such as { "email": "a@b.com" }.');
        }
      }
    }

    node.pinnedData = parsed === undefined ? undefined : summariseForSample(parsed);
    workflow.markModified('nodes');
    await workflow.save();

    res.json({ ok: true, pinned: node.pinnedData !== undefined });
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

/** Starter templates shown when creating a workflow. */
router.get('/meta/templates', (_req, res) => {
  res.json({
    templates: workflowTemplates.map(({ nodes, edges, ...rest }) => ({
      ...rest,
      stepCount: nodes.length,
    })),
  });
});

/** Creates a workflow from a template. */
router.post(
  '/from-template/:templateId',
  asyncHandler(async (req, res) => {
    const template = getTemplate(req.params.templateId);
    if (!template) throw AppError.notFound('Template not found');

    const workflow = await Workflow.create({
      name: String(req.body?.name || template.name),
      description: template.description,
      nodes: template.nodes,
      edges: template.edges.map((edge) => ({
        sourceHandle: 'main',
        targetHandle: 'main',
        ...edge,
      })),
      active: false,
      webhookId: nanoid(22),
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    });

    res.status(201).json({ workflow: withWebhookUrls(workflow) });
  }),
);

export default router;
