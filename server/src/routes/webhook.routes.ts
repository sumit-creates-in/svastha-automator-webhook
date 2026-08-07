import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { executeRun } from '../engine/executor';
import { getPath } from '../engine/expression';
import { enqueueRun } from '../engine/queue';
import type { WorkflowNode } from '../engine/types';
import { hmacSha256Hex, safeCompare } from '../lib/crypto';
import { asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { Job } from '../models/Job';
import { Run } from '../models/Run';
import { Workflow } from '../models/Workflow';

const router = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

function normalisePath(value: unknown): string {
  return String(value ?? '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function checkAuth(node: WorkflowNode, req: Request): string | null {
  const params = (node.params ?? {}) as Record<string, any>;
  const mode = String(params.authentication ?? 'none');
  if (mode === 'none') return null;

  const headerName = String(params.authHeaderName ?? 'x-webhook-token').toLowerCase();
  const provided = req.headers[headerName];
  const expected = String(params.authToken ?? '');

  if (!expected) return null;
  if (typeof provided !== 'string' || !provided) return 'Missing authentication header';

  if (mode === 'header') {
    return safeCompare(provided, expected) ? null : 'Invalid token';
  }

  if (mode === 'hmac') {
    const raw = (req as Request & { rawBody?: string }).rawBody ?? '';
    const signature = hmacSha256Hex(expected, raw);
    const cleaned = provided.replace(/^sha256=/i, '');
    return safeCompare(cleaned, signature) ? null : 'Invalid signature';
  }

  return null;
}

/**
 * Public webhook endpoint: /api/webhooks/:webhookId[/optional/path]
 * No authentication middleware — the URL itself is a secret, with optional
 * token or HMAC verification configured on the node.
 */
const handleWebhook = asyncHandler(async (req, res) => {
  {
    const { webhookId } = req.params as { webhookId: string };
    const suffix = normalisePath((req.params as Record<string, unknown>)['0']);

    const workflow = await Workflow.findOne({ webhookId });
    if (!workflow) {
      res.status(404).json({ error: 'Unknown webhook' });
      return;
    }

    const nodes = workflow.nodes as unknown as WorkflowNode[];
    const candidates = nodes.filter((node) => node.type === 'webhookTrigger' && !node.disabled);

    const triggerNode =
      candidates.find((node) => normalisePath((node.params as Record<string, unknown>)?.path) === suffix) ??
      (suffix === '' ? candidates[0] : undefined);

    if (!triggerNode) {
      res.status(404).json({ error: 'No webhook step matches this path' });
      return;
    }

    const params = (triggerNode.params ?? {}) as Record<string, any>;
    const allowedMethod = String(params.httpMethod ?? 'POST').toUpperCase();
    if (allowedMethod !== 'ANY' && req.method.toUpperCase() !== allowedMethod) {
      res.status(405).json({ error: `This webhook expects ${allowedMethod}` });
      return;
    }

    const authError = checkAuth(triggerNode, req);
    if (authError) {
      res.status(401).json({ error: authError });
      return;
    }

    if (!workflow.active) {
      res.status(409).json({
        error: 'This workflow is not active. Turn it on in SVASTHA Automator to start receiving data.',
      });
      return;
    }

    const payload: Record<string, unknown> = {
      method: req.method,
      path: suffix,
      headers: req.headers,
      query: req.query,
      body: req.body ?? {},
      ip: req.ip,
      receivedAt: new Date().toISOString(),
    };
    if (params.rawBody) {
      payload.rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    }

    // Ignore a delivery we have already accepted, if the author asked us to.
    const dedupeWindow = Number(params.dedupeWindowSeconds ?? 0);
    let dedupeKey: string | undefined;

    if (dedupeWindow > 0) {
      const basis = params.dedupeField
        ? getPath(payload, String(params.dedupeField))
        : (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

      dedupeKey = crypto
        .createHash('sha256')
        .update(`${workflow._id}:${triggerNode.id}:${JSON.stringify(basis ?? '')}`)
        .digest('hex');

      const since = new Date(Date.now() - dedupeWindow * 1000);
      const previous = await Run.findOne({ dedupeKey, createdAt: { $gte: since } })
        .select('_id')
        .lean();

      if (previous) {
        logger.info(
          { workflow: workflow.name, runId: String(previous._id) },
          'Ignored a duplicate webhook delivery',
        );
        res.status(200).json({
          accepted: true,
          duplicate: true,
          runId: String(previous._id),
          note: `An identical delivery was already accepted within the last ${dedupeWindow}s.`,
        });
        return;
      }
    }

    const responseMode = String(params.responseMode ?? 'immediately');

    if (responseMode !== 'lastNode') {
      const { runId } = await enqueueRun({
        workflow,
        triggerNode,
        payload,
        mode: 'webhook',
        dedupeKey,
      });
      res.status(202).json({ accepted: true, runId });
      return;
    }

    // Synchronous mode: run now and reply with the workflow output.
    const { runId, jobId } = await enqueueRun({
      workflow,
      triggerNode,
      payload,
      mode: 'webhook',
      inline: true,
      dedupeKey,
    });

    const timeoutMs = Number(params.responseTimeoutMs ?? 30000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        res.status(202).json({ accepted: true, runId, note: 'Still running — response timed out' });
      }
    }, timeoutMs);

    try {
      const result = await executeRun(runId);

      if (result.status === 'waiting' && result.resumeAt) {
        await Job.updateOne(
          { _id: jobId },
          { $set: { status: 'pending', runAt: result.resumeAt, lockedAt: null, lockedBy: null, attempts: 0 } },
        );
      } else {
        await Job.updateOne({ _id: jobId }, { $set: { status: 'done', lockedAt: null } });
      }

      clearTimeout(timer);
      if (timedOut || res.headersSent) return;

      if (result.webhookResponse) {
        const { statusCode, headers, body, hasBody } = result.webhookResponse;
        for (const [key, value] of Object.entries(headers ?? {})) res.setHeader(key, value);
        if (!hasBody) {
          res.status(statusCode).end();
          return;
        }
        res.status(statusCode).json(body);
        return;
      }

      if (result.status === 'error') {
        res.status(500).json({ error: result.error, runId });
        return;
      }

      res.status(200).json(result.lastOutput ?? { ok: true, runId });
    } catch (error) {
      clearTimeout(timer);
      logger.error({ err: error, runId }, 'Inline webhook execution failed');
      if (!res.headersSent) res.status(500).json({ error: 'Workflow execution failed', runId });
    }
  }
});

router.all('/:webhookId', webhookLimiter, handleWebhook);
router.all('/:webhookId/*', webhookLimiter, handleWebhook);

export default router;
