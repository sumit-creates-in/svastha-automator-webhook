/**
 * MCP connector: lets Claude (Claude Code, a claude.ai custom connector) look after the automator without the
 * browser: read workflows and runs, find failures, and make small, logged, undoable changes.
 *
 * Streamable HTTP, stateless, JSON only: every POST /mcp is one JSON-RPC message (or a batch) and gets one JSON
 * answer. Same design as the SVASTHA brain connector (svastha-crm/brain/src/mcp.js).
 *
 * Auth: MCP_KEY (env, min 24 chars), as "Authorization: Bearer <key>" (Claude Code) or in the path /mcp/<key>
 * (claude.ai custom connectors cannot send headers). Separate from the login JWT, so it can be rotated alone.
 *
 * Safety:
 *  - Secrets are never returned: header values, tokens, keys, passwords and the secret parts of webhook URLs
 *    are masked in everything this connector answers. Customer phone numbers / emails in run data are masked
 *    unless include_data is asked for explicitly.
 *  - The one exception: create_alert_email_workflow returns the new workflow's address (the caller already holds
 *    the token that protects it, because it chose it).
 *  - Every change is saved first in the "mcp_changes" collection (before + after) and can be undone with
 *    undo_change. Nothing here sends messages: there is no "test run" tool.
 */
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import { env } from './config/env';
import { resolveParams } from './engine/executor';
import { defaultParamsFor, requireNodeDefinition } from './engine/registry';
import { syncWorkflowSchedules } from './engine/scheduler';
import type { ExpressionScope, WorkflowNode } from './engine/types';
import { Connection } from './models/Connection';
import { Run } from './models/Run';
import { Workflow } from './models/Workflow';
import { validateWorkflow } from './routes/workflow.routes';

const PROTOCOL = '2025-06-18';

const INSTRUCTIONS = `This is the SVASTHA automator: the webhook -> workflow engine behind many WhatsApp messages, emails,
Google Sheet rows and CRM leads (Nav Fit leads, Razorpay payments, support tickets, 1-on-1 messages, ...).
Each workflow = a trigger (webhook / schedule) + steps (HTTP request, send email, Google Sheets, ...).

Safe way to work:
1. automator_status or error_summary to see what is failing.
2. get_workflow to read the steps (secrets are masked), get_run to see what a step received and why it failed.
3. update_step with a small change and a reason (saved with an undo record), set_workflow_active to switch on/off.
4. add_crm_step adds a "send to the SVASTHA CRM" step (address copied from an existing CRM step, never typed);
   test_crm_step runs ONE CRM step with a sample body ([TEST] leads only) — nothing else in the workflow runs.
5. create_alert_email_workflow sets up a token-protected "webhook -> send email" workflow (switched off) for
   alert emails from another SVASTHA app; switch it on with set_workflow_active.
6. list_changes / undo_change if a change was wrong.
Never put customer personal data in a reason. Changing a step that sends messages changes what customers get:
only do it when the owner asked.`;

// ---------------------------------------------------------------- helpers --
function timingSafeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorised(req: Request): { ok: boolean; status?: number; message?: string } {
  const key = process.env.MCP_KEY ?? '';
  if (key.length < 24) return { ok: false, status: 503, message: 'MCP_KEY is not set on the automator (min 24 characters).' };
  const header = req.get('authorization') ?? '';
  const given = (req.params as Record<string, string>).key || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  if (!given || !timingSafeEqual(given, key)) return { ok: false, status: 401, message: 'Invalid or missing MCP key.' };
  return { ok: true };
}

const SECRET_NAME = /secret|token|password|passwd|api[-_]?key|apikey|authorization|signature|x-svastha|bearer|private|credential/i;

/** Masks secret-looking values anywhere in a value (recursively). */
export function maskSecrets(value: unknown, parentKey = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (SECRET_NAME.test(parentKey)) return value ? '<hidden>' : value;
    return value
      .replace(/(\/api\/webhooks\/)[A-Za-z0-9_-]{8,}/g, '$1<id>')
      .replace(/(\/api\/hooks\/)[A-Za-z0-9_.-]+/g, '$1<key>')
      .replace(/(\/intake\/webhook\/)[^/?"'\s]+/g, '$1<secret>')
      .replace(/(\/macros\/s\/)[A-Za-z0-9_-]+/g, '$1<script-id>')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<hidden>')
      .replace(/([?&](?:key|token|secret|apikey|api_key|sig)=)[^&\s"']+/gi, '$1<hidden>');
  }
  if (Array.isArray(value)) {
    // {key, value} pairs (headers, form fields): judge the value by its key name
    return value.map((item) => {
      if (item && typeof item === 'object' && 'key' in item && 'value' in item) {
        const k = String((item as { key: unknown }).key ?? '');
        return { ...(item as object), value: SECRET_NAME.test(k) ? '<hidden>' : maskSecrets((item as { value: unknown }).value, k) };
      }
      return maskSecrets(item, parentKey);
    });
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskSecrets(v, k);
    return out;
  }
  return value;
}

/** Masks phone numbers and email addresses (customer data) in free text / JSON. */
export function maskPersonal(value: unknown): unknown {
  const s = JSON.stringify(value ?? null)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\+?\d[\d\s-]{8,}\d/g, (m) => `<phone …${m.replace(/\D/g, '').slice(-2)}>`);
  try { return JSON.parse(s); } catch { return s; }
}

const clip = (value: unknown, max = 1500): unknown => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : value;
};

const text = (t: unknown) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

class ToolError extends Error {}

async function findWorkflow(ref: unknown) {
  const r = String(ref ?? '').trim();
  if (!r) throw new ToolError('workflow is required (name or id).');
  const byId = mongoose.isValidObjectId(r) ? await Workflow.findById(r) : null;
  if (byId) return byId;
  const exact = await Workflow.find({ name: r }).limit(2);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new ToolError(`Two workflows are called "${r}"; use the id.`);
  const like = await Workflow.find({ name: { $regex: r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }).limit(5);
  if (like.length === 1) return like[0];
  if (like.length === 0) throw new ToolError(`No workflow matches "${r}".`);
  throw new ToolError(`"${r}" matches several workflows: ${like.map((w) => `${w.name} (${w._id})`).join(', ')}`);
}

const changes = () => mongoose.connection.collection('mcp_changes');

/**
 * What a change touches: steps, links, on/off and settings. Undo compares this, not updatedAt — every incoming
 * webhook saves a payload sample on the workflow (updatedAt moves), which used to block undo after any live run.
 */
export function workflowShape(w: any): string {
  const o = typeof w?.toObject === 'function' ? w.toObject() : w;
  return crypto.createHash('sha256')
    .update(JSON.stringify({ nodes: o?.nodes ?? [], edges: o?.edges ?? [], active: o?.active ?? null, settings: o?.settings ?? {} }))
    .digest('hex');
}

async function recordChange(entry: Record<string, unknown>) {
  const doc = { ...entry, at: new Date(), by: 'claude-mcp', undone: false };
  const res = await changes().insertOne(doc);
  return String(res.insertedId);
}

async function errorGroups(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await Run.aggregate([
    { $match: { status: 'error', createdAt: { $gte: since } } },
    { $project: { workflowName: 1, createdAt: 1, msg: { $substrCP: [{ $ifNull: ['$error', ''] }, 0, 220] } } },
    { $group: { _id: { wf: '$workflowName', msg: '$msg' }, n: { $sum: 1 }, first: { $min: '$createdAt' }, last: { $max: '$createdAt' } } },
    { $sort: { n: -1 } },
    { $limit: 30 },
  ]);
  return rows.map((r) => ({
    workflow: r._id.wf,
    count: r.n,
    first: r.first,
    last: r.last,
    error: maskPersonal(maskSecrets(r._id.msg)),
  }));
}

/**
 * The SVASTHA CRM's intake addresses (open webhook, /lead, /event). The two CRM tools below only ever touch an
 * HTTP step whose URL is one of these, so they can never send an email, a WhatsApp message or call anything else.
 */
const CRM_INTAKE = /^https:\/\/[^/]+\/v1\/intake\/(webhook\/[^/?#\s]+|lead|event)\/?$/;
export const isCrmStep = (node: any) => node?.type === 'httpRequest' && CRM_INTAKE.test(String(node.params?.url ?? ''));
const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/** Expression scope for a step that sits right after a webhook trigger, as the engine builds it. */
function webhookScope(w: any, body: Record<string, unknown>): ExpressionScope {
  const trigger = { method: 'POST', path: '', headers: {}, query: {}, body };
  return {
    $json: trigger, $trigger: trigger, $node: {}, $vars: (w.variables ?? {}) as Record<string, unknown>,
    $runId: 'connector-test', $workflowId: String(w._id), $workflowName: String(w.name),
    $now: new Date().toISOString(), $timestamp: Date.now(), $itemIndex: 0, $itemCount: 1,
  } as unknown as ExpressionScope;
}

/**
 * The two steps of an alert-email workflow: a webhook that only accepts requests carrying the token in the
 * x-alert-token header, and a Send Email step whose recipients, subject and body come from the request.
 * The token is what keeps this from being an open mail relay, so it must be long and random.
 */
export function alertEmailNodes(connectionId: string, token: string, fromName: string) {
  const trigger = {
    id: newId('node'), type: 'webhookTrigger', name: 'Alert from app', position: { x: 0, y: 0 },
    params: {
      ...defaultParamsFor('webhookTrigger'),
      httpMethod: 'POST', path: '', authentication: 'header', authHeaderName: 'x-alert-token', authToken: token,
      responseMode: 'immediately', dedupeWindowSeconds: 0, rawBody: false,
    },
    disabled: false, onError: 'stop', retryOnFail: false, maxTries: 3,
  };
  const email = {
    id: newId('node'), type: 'sendEmail', name: 'Send alert email', position: { x: 320, y: 0 },
    params: {
      ...defaultParamsFor('sendEmail'),
      connection: connectionId, to: '{{ $json.body.to }}', fromName, subject: '{{ $json.body.subject }}',
      format: 'both', html: '{{ $json.body.html }}', text: '{{ $json.body.text }}', attachments: [],
    },
    disabled: false, onError: 'stop', retryOnFail: true, maxTries: 3,
  };
  return { nodes: [trigger, email], edges: [{ id: newId('edge'), source: trigger.id, target: email.id, sourceHandle: 'main', targetHandle: 'main' }] };
}

// ------------------------------------------------------------------ tools --
const TOOLS = [
  {
    name: 'automator_status',
    description: 'Runs in the last 24 h by status, active workflows, and the most common errors (masked).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'error_summary',
    description: 'Failed runs grouped by workflow + error message, for the last N hours (default 24, max 720).',
    inputSchema: { type: 'object', properties: { hours: { type: 'number' } } },
  },
  {
    name: 'list_workflows',
    description: 'All workflows: id, name, active, trigger, number of steps, runs and failures in the last 24 h.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'get_workflow',
    description: 'One workflow (by name or id): steps with their settings (secrets masked), connections between steps, settings and problems the editor would show.',
    inputSchema: { type: 'object', properties: { workflow: { type: 'string' } }, required: ['workflow'] },
  },
  {
    name: 'list_runs',
    description: 'Recent runs, newest first. Filter by workflow (name or id) and/or status (success, error, running, queued, waiting, cancelled). Max 50.',
    inputSchema: { type: 'object', properties: { workflow: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'get_run',
    description: 'One run: every step with status, duration and error. Step input/output are shortened; phone numbers and emails are masked unless include_data is true (only when the owner needs it).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, include_data: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'list_connections',
    description: 'Saved connections (email / Google etc.): id, name, type, last test result. Never their secrets.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_step',
    description: 'Change settings of ONE step: "params" are merged into the step parameters (set a key to null to remove it); "options" may set onError (stop|continue), retryOnFail, maxTries, disabled. The workflow is saved with an undo record. A reason is required.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string' },
        step: { type: 'string', description: 'step name or id' },
        params: { type: 'object' },
        options: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['workflow', 'step', 'reason'],
    },
  },
  {
    name: 'add_crm_step',
    description: 'Add an HTTP step that sends the lead from this workflow to the SVASTHA CRM. The CRM address (it contains a secret) is copied server-side from an existing CRM step ("url_from": {workflow, step}), never typed. Connected from the "after" step (default: the trigger), with onError continue and 3 tries, so it never blocks the rest of the workflow. Saved with an undo record.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string' },
        name: { type: 'string', description: 'name of the new step, e.g. "Send to CRM"' },
        body_json: { type: 'string', description: 'JSON body template ({{ }} expressions allowed)' },
        url_from: { type: 'object', properties: { workflow: { type: 'string' }, step: { type: 'string' } }, required: ['workflow', 'step'] },
        after: { type: 'string', description: 'step name or id to connect from (default: the trigger)' },
        reason: { type: 'string' },
      },
      required: ['workflow', 'name', 'body_json', 'url_from', 'reason'],
    },
  },
  {
    name: 'test_crm_step',
    description: 'Run ONE CRM step (an HTTP step that sends to the SVASTHA CRM intake) with a sample webhook body, without running anything else in the workflow. The resolved body must name the lead "[TEST] ..." so the CRM files it as a test lead. Returns the CRM answer.',
    inputSchema: {
      type: 'object',
      properties: { workflow: { type: 'string' }, step: { type: 'string' }, body: { type: 'object', description: 'what the webhook would receive as its body' } },
      required: ['workflow', 'step', 'body'],
    },
  },
  {
    name: 'create_alert_email_workflow',
    description: 'Create a NEW workflow (switched off): a webhook that needs the header "x-alert-token: <token>", then a Send Email step through a saved email/Google connection; to, subject, html and text come from the request body. For alert emails sent by another SVASTHA app (e.g. the CRM). The caller chooses the token (at least 32 random characters) and stores it where the sending app reads it. Returns the webhook address. Saved with an undo record (undo deletes the workflow).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'workflow name, e.g. "CRM alerts -> email"' },
        connection: { type: 'string', description: 'saved connection name or id to send with' },
        token: { type: 'string', description: 'at least 32 random characters' },
        from_name: { type: 'string', description: 'sender name shown in the inbox' },
        reason: { type: 'string' },
      },
      required: ['name', 'connection', 'token', 'from_name', 'reason'],
    },
  },
  {
    name: 'set_workflow_active',
    description: 'Switch a workflow on or off (same checks as the editor). Saved with an undo record.',
    inputSchema: { type: 'object', properties: { workflow: { type: 'string' }, active: { type: 'boolean' }, reason: { type: 'string' } }, required: ['workflow', 'active', 'reason'] },
  },
  {
    name: 'list_changes',
    description: 'Changes made through this connector (newest first) with their ids, for undo_change.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'undo_change',
    description: 'Puts a workflow back exactly as it was before the given change (only if nobody changed it since).',
    inputSchema: { type: 'object', properties: { change_id: { type: 'string' }, reason: { type: 'string' } }, required: ['change_id', 'reason'] },
  },
];

async function callTool(name: string, args: Record<string, any>) {
  switch (name) {
    case 'automator_status': {
      const since = new Date(Date.now() - 24 * 3600_000);
      const [byStatus, workflows, active] = await Promise.all([
        Run.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
        Workflow.countDocuments(),
        Workflow.countDocuments({ active: true }),
      ]);
      return text({
        last24h: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
        workflows,
        activeWorkflows: active,
        topErrors24h: (await errorGroups(24)).slice(0, 10),
      });
    }

    case 'error_summary': {
      const hours = Math.min(720, Math.max(1, Number(args.hours ?? 24)));
      return text({ hours, groups: await errorGroups(hours) });
    }

    case 'list_workflows': {
      const filter: Record<string, unknown> = {};
      if (args.search) filter.name = { $regex: String(args.search), $options: 'i' };
      const list = await Workflow.find(filter).sort({ name: 1 }).limit(300).select('name active nodes.type nodes.name updatedAt');
      const since = new Date(Date.now() - 24 * 3600_000);
      const stats = await Run.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { wf: '$workflow', st: '$status' }, n: { $sum: 1 } } },
      ]);
      const per: Record<string, Record<string, number>> = {};
      for (const s of stats) (per[String(s._id.wf)] ??= {})[s._id.st] = s.n;
      return text(list.map((w) => {
        const nodes = (w.nodes ?? []) as unknown as WorkflowNode[];
        const trig = nodes.find((n) => /trigger/i.test(n.type));
        return {
          id: String(w._id), name: w.name, active: w.active, trigger: trig?.type ?? null, steps: nodes.length,
          runs24h: per[String(w._id)] ?? {}, updatedAt: (w as any).updatedAt,
        };
      }));
    }

    case 'get_workflow': {
      const w = await findWorkflow(args.workflow);
      const nodes = (w.nodes ?? []) as unknown as WorkflowNode[];
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n.name]));
      return text({
        id: String(w._id),
        name: w.name,
        active: w.active,
        steps: nodes.map((n: any) => ({
          id: n.id, name: n.name, type: n.type, disabled: n.disabled, onError: n.onError,
          retryOnFail: n.retryOnFail, maxTries: n.maxTries, params: maskSecrets(n.params ?? {}),
        })),
        links: (w.edges ?? []).map((e: any) => `${byId[e.source] ?? e.source} -> ${byId[e.target] ?? e.target}${e.sourceHandle && e.sourceHandle !== 'main' ? ` (${e.sourceHandle})` : ''}`),
        settings: maskSecrets((w as any).settings ?? {}),
        problems: validateWorkflow(nodes, (w.edges ?? []) as any),
      });
    }

    case 'list_runs': {
      const filter: Record<string, unknown> = {};
      if (args.workflow) filter.workflow = (await findWorkflow(args.workflow))._id;
      if (args.status) filter.status = String(args.status);
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const runs = await Run.find(filter).sort({ createdAt: -1 }).limit(limit).select('-steps');
      return text(runs.map((r: any) => ({
        id: String(r._id), workflow: r.workflowName, status: r.status, mode: r.mode, startedAt: r.startedAt ?? r.createdAt,
        durationMs: r.durationMs, error: r.error ? maskPersonal(maskSecrets(String(r.error).slice(0, 300))) : undefined,
      })));
    }

    case 'get_run': {
      if (!mongoose.isValidObjectId(String(args.id))) throw new ToolError('Not a run id.');
      const r: any = await Run.findById(String(args.id));
      if (!r) throw new ToolError('Run not found (runs are kept for a limited time).');
      const personal = args.include_data === true ? (v: unknown) => v : maskPersonal;
      return text({
        id: String(r._id), workflow: r.workflowName, status: r.status, mode: r.mode,
        startedAt: r.startedAt, durationMs: r.durationMs,
        error: r.error ? personal(maskSecrets(r.error)) : undefined,
        trigger: { node: r.trigger?.nodeName, payload: clip(personal(maskSecrets(r.trigger?.payload ?? null)), 1500) },
        steps: (r.steps ?? []).map((s: any) => ({
          step: s.nodeName, status: s.status, durationMs: s.durationMs,
          error: s.error ? personal(maskSecrets(s.error)) : undefined,
          input: clip(personal(maskSecrets(s.input ?? null)), 800),
          output: clip(personal(maskSecrets(s.output ?? null)), 800),
        })),
      });
    }

    case 'list_connections': {
      const list = await Connection.find().sort({ name: 1 });
      return text(list.map((c: any) => ({ id: String(c._id), name: c.name, type: c.type, lastTestedAt: c.lastTestedAt, lastTestOk: c.lastTestOk })));
    }

    case 'update_step': {
      const reason = String(args.reason ?? '').trim();
      if (reason.length < 5) throw new ToolError('Give a short reason (it is saved with the change).');
      const w = await findWorkflow(args.workflow);
      const nodes = JSON.parse(JSON.stringify(w.nodes ?? [])) as any[];
      const stepRef = String(args.step ?? '');
      const idx = nodes.findIndex((n) => n.id === stepRef || n.name === stepRef);
      if (idx < 0) throw new ToolError(`No step "${stepRef}" in "${w.name}". Steps: ${nodes.map((n) => n.name).join(', ')}`);
      const before = JSON.parse(JSON.stringify(w.toObject()));
      const node = nodes[idx];
      if (args.params && typeof args.params === 'object') {
        const params = { ...(node.params ?? {}) };
        for (const [k, v] of Object.entries(args.params as Record<string, unknown>)) {
          if (v === null) delete params[k]; else params[k] = v;
        }
        node.params = params;
      }
      const opts = (args.options ?? {}) as Record<string, unknown>;
      if (opts.onError !== undefined) {
        if (!['stop', 'continue'].includes(String(opts.onError))) throw new ToolError('onError must be stop or continue.');
        node.onError = opts.onError;
      }
      if (opts.retryOnFail !== undefined) node.retryOnFail = Boolean(opts.retryOnFail);
      if (opts.maxTries !== undefined) node.maxTries = Math.min(10, Math.max(1, Number(opts.maxTries)));
      if (opts.disabled !== undefined) node.disabled = Boolean(opts.disabled);
      const problems = validateWorkflow(nodes, (w.edges ?? []) as any).filter((p) => p.level === 'error');
      if (w.active && problems.length) throw new ToolError(`This would break an active workflow: ${problems.map((p) => p.message).join('; ')}`);
      w.set('nodes', nodes);
      await w.save();
      await syncWorkflowSchedules(w);
      const changeId = await recordChange({ kind: 'update_step', workflowId: String(w._id), workflowName: w.name, step: node.name, reason, before, afterUpdatedAt: (w as any).updatedAt, afterShape: workflowShape(await Workflow.findById(w._id)) });
      return text({ ok: true, changeId, workflow: w.name, step: node.name, params: maskSecrets(node.params), onError: node.onError, retryOnFail: node.retryOnFail, disabled: node.disabled });
    }

    case 'add_crm_step': {
      const reason = String(args.reason ?? '').trim();
      if (reason.length < 5) throw new ToolError('Give a short reason (it is saved with the change).');
      const name = String(args.name ?? '').trim();
      if (!name) throw new ToolError('name is required.');
      const bodyJson = String(args.body_json ?? '');
      if (!bodyJson.trim().startsWith('{')) throw new ToolError('body_json must be a JSON object template.');

      const src = await findWorkflow(args.url_from?.workflow);
      const srcNode: any = ((src.nodes ?? []) as any[]).find((n) => n.id === args.url_from?.step || n.name === args.url_from?.step);
      if (!srcNode) throw new ToolError(`No step "${args.url_from?.step}" in "${src.name}".`);
      if (!isCrmStep(srcNode)) throw new ToolError(`"${srcNode.name}" in "${src.name}" is not a CRM intake step; copy the address from one that is.`);

      const w = await findWorkflow(args.workflow);
      const nodes = JSON.parse(JSON.stringify(w.nodes ?? [])) as any[];
      const edges = JSON.parse(JSON.stringify(w.edges ?? [])) as any[];
      if (nodes.some((n) => n.name === name)) throw new ToolError(`"${w.name}" already has a step called "${name}".`);
      const fromRef = args.after ? String(args.after) : null;
      const from = fromRef
        ? nodes.find((n) => n.id === fromRef || n.name === fromRef)
        : nodes.find((n) => requireNodeDefinition(n.type).group === 'trigger');
      if (!from) throw new ToolError(fromRef ? `No step "${fromRef}" in "${w.name}".` : `"${w.name}" has no trigger.`);

      const before = JSON.parse(JSON.stringify(w.toObject()));
      const node = {
        id: newId('node'),
        type: 'httpRequest',
        name,
        position: { x: Number(from.position?.x ?? 0) + 320, y: Number(from.position?.y ?? 0) + 220 },
        params: {
          ...defaultParamsFor('httpRequest'),
          method: 'POST',
          url: srcNode.params.url,
          bodyType: 'json',
          bodyJson,
          bodyFields: [],
          queryParams: [],
          headers: [],
          timeoutMs: 120000,
          ignoreSslErrors: false,
          neverError: false,
          responseFormat: 'auto',
        },
        disabled: false,
        onError: 'continue',
        retryOnFail: true,
        maxTries: 3,
      };
      nodes.push(node);
      // First in the list: the engine runs a step's branches in this order and a failing "stop" step (a Sheet or
      // an email) ends the whole run — so the lead reaches the CRM before anything else can stop it.
      edges.unshift({ id: newId('edge'), source: from.id, target: node.id, sourceHandle: 'main', targetHandle: 'main' });
      const problems = validateWorkflow(nodes, edges).filter((p) => p.level === 'error');
      if (problems.length) throw new ToolError(`This would break the workflow: ${problems.map((p) => p.message).join('; ')}`);
      w.set({ nodes, edges });
      await w.save();
      await syncWorkflowSchedules(w);
      const changeId = await recordChange({ kind: 'add_crm_step', workflowId: String(w._id), workflowName: w.name, step: name, reason, before, afterUpdatedAt: (w as any).updatedAt, afterShape: workflowShape(await Workflow.findById(w._id)) });
      return text({ ok: true, changeId, workflow: w.name, step: name, connectedFrom: from.name, params: maskSecrets(node.params), onError: node.onError, retryOnFail: node.retryOnFail });
    }

    case 'test_crm_step': {
      const w = await findWorkflow(args.workflow);
      const node: any = ((w.nodes ?? []) as any[]).find((n) => n.id === args.step || n.name === args.step);
      if (!node) throw new ToolError(`No step "${args.step}" in "${w.name}".`);
      if (!isCrmStep(node)) throw new ToolError(`"${node.name}" is not a CRM intake step; only those can be tested here.`);
      const body = (args.body && typeof args.body === 'object') ? args.body as Record<string, unknown> : {};
      const params = resolveParams(node as WorkflowNode, webhookScope(w, body));
      // Only test leads: the CRM files a "[TEST] ..." name as a test lead (no owner, nobody notified).
      let resolved: any = null;
      try { resolved = params.bodyType === 'json' ? JSON.parse(String(params.bodyJson ?? '')) : null; } catch (e) {
        return text({ ok: false, stage: 'template', error: `The body is not valid JSON after filling it in: ${(e as Error).message}`, body: maskPersonal(String(params.bodyJson ?? '').slice(0, 1500)) });
      }
      if (!resolved || !/^\s*\[test\]/i.test(String(resolved.name ?? resolved.full_name ?? ''))) {
        throw new ToolError('Test bodies must produce a lead named "[TEST] ..." (so the CRM keeps it as a test lead).');
      }
      const definition = requireNodeDefinition('httpRequest');
      const logs: string[] = [];
      try {
        const out: any = await definition.execute!({
          node: { ...node, params: node.params }, params, rawParams: node.params ?? {}, input: { body },
          scope: webhookScope(w, body), runId: 'connector-test', workflowId: String(w._id),
          getConnection: async () => { throw new Error('CRM steps use no saved connection'); },
          resolve: (v: unknown) => v, log: (m: string) => logs.push(m), signal: new AbortController().signal,
        } as any);
        const data = out?.data ?? {};
        return text({ ok: true, sent: maskPersonal(resolved), status: data.statusCode, response: maskPersonal(maskSecrets(clip(data.body ?? data.data ?? null, 1200))) });
      } catch (e) {
        return text({ ok: false, stage: 'request', sent: maskPersonal(resolved), error: maskPersonal(maskSecrets(String((e as Error).message).slice(0, 800))) });
      }
    }

    case 'create_alert_email_workflow': {
      const reason = String(args.reason ?? '').trim();
      if (reason.length < 5) throw new ToolError('Give a short reason (it is saved with the change).');
      const name = String(args.name ?? '').trim();
      if (!name) throw new ToolError('name is required.');
      if (await Workflow.exists({ name })) throw new ToolError(`A workflow called "${name}" already exists.`);
      const token = String(args.token ?? '');
      if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new ToolError('token must be at least 32 characters of letters, digits, - or _.');
      const fromName = String(args.from_name ?? '').trim().slice(0, 80);
      if (!fromName) throw new ToolError('from_name is required.');
      const ref = String(args.connection ?? '').trim();
      const conn: any = (mongoose.isValidObjectId(ref) ? await Connection.findById(ref) : null) ?? await Connection.findOne({ name: ref });
      if (!conn) throw new ToolError(`No saved connection "${ref}".`);
      if (!['smtp', 'googleOAuth2', 'googleServiceAccount'].includes(String(conn.type))) {
        throw new ToolError(`"${conn.name}" (${conn.type}) cannot send email.`);
      }
      const { nodes, edges } = alertEmailNodes(String(conn._id), token, fromName);
      const problems = validateWorkflow(nodes as unknown as WorkflowNode[], edges as any).filter((p) => p.level === 'error');
      if (problems.length) throw new ToolError(`The workflow would not be valid: ${problems.map((p) => p.message).join('; ')}`);
      const w = await Workflow.create({
        name, description: `Alert emails from another SVASTHA app. Created by the Claude connector: ${reason}`.slice(0, 500),
        active: false, nodes, edges, webhookId: nanoid(22),
        settings: { timezone: 'Asia/Kolkata', saveSuccessfulRunData: true, saveFailedRunData: true, timeoutMs: 120000, captureSampleData: false, errorEmailTo: '' },
        tags: ['alerts'],
      });
      const changeId = await recordChange({ kind: 'create_workflow', workflowId: String(w._id), workflowName: w.name, reason, before: null, afterUpdatedAt: (w as any).updatedAt, afterShape: workflowShape(await Workflow.findById(w._id)) });
      return text({
        ok: true, changeId, workflowId: String(w._id), workflow: w.name, active: false, connection: conn.name,
        webhookUrl: `${env.appUrl}/api/webhooks/${w.webhookId}`,
        header: 'x-alert-token',
        body: '{"to": "a@x.com, b@y.com", "subject": "...", "html": "<p>...</p>", "text": "..."}',
        next: 'Switch it on with set_workflow_active once the sending app has the address and the token.',
      });
    }

    case 'set_workflow_active': {
      const reason = String(args.reason ?? '').trim();
      if (reason.length < 5) throw new ToolError('Give a short reason (it is saved with the change).');
      const w = await findWorkflow(args.workflow);
      const active = Boolean(args.active);
      if (active) {
        const problems = validateWorkflow((w.nodes ?? []) as unknown as WorkflowNode[], (w.edges ?? []) as any).filter((p) => p.level === 'error');
        if (problems.length) throw new ToolError(`Fix these first: ${problems.map((p) => p.message).join('; ')}`);
      }
      const before = JSON.parse(JSON.stringify(w.toObject()));
      w.set('active', active);
      await w.save();
      await syncWorkflowSchedules(w);
      const changeId = await recordChange({ kind: 'set_active', workflowId: String(w._id), workflowName: w.name, active, reason, before, afterUpdatedAt: (w as any).updatedAt, afterShape: workflowShape(await Workflow.findById(w._id)) });
      return text({ ok: true, changeId, workflow: w.name, active });
    }

    case 'list_changes': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const rows = await changes().find({}, { projection: { before: 0 } }).sort({ at: -1 }).limit(limit).toArray();
      return text(rows.map((r: any) => ({ id: String(r._id), at: r.at, kind: r.kind, workflow: r.workflowName, step: r.step, active: r.active, reason: r.reason, undone: r.undone })));
    }

    case 'undo_change': {
      const reason = String(args.reason ?? '').trim();
      if (reason.length < 5) throw new ToolError('Give a short reason.');
      if (!mongoose.isValidObjectId(String(args.change_id))) throw new ToolError('Not a change id.');
      const ch: any = await changes().findOne({ _id: new mongoose.Types.ObjectId(String(args.change_id)) });
      if (!ch) throw new ToolError('Change not found.');
      if (ch.undone) throw new ToolError('That change was already undone.');
      const w = await Workflow.findById(ch.workflowId);
      if (!w) throw new ToolError('The workflow no longer exists.');
      const changedSince = ch.afterShape
        ? workflowShape(w) !== ch.afterShape
        : ch.afterUpdatedAt && new Date((w as any).updatedAt).getTime() !== new Date(ch.afterUpdatedAt).getTime();
      if (changedSince) {
        throw new ToolError('The workflow was changed again after this change; undo would overwrite that. Fix it by hand or with update_step.');
      }
      if (ch.kind === 'create_workflow') {
        // Undoing a creation removes the workflow again; only possible while nobody has changed it.
        await Workflow.deleteOne({ _id: w._id });
        await changes().updateOne({ _id: ch._id }, { $set: { undone: true, undoneAt: new Date(), undoReason: reason } });
        return text({ ok: true, workflow: w.name, removed: true });
      }
      const prev = ch.before;
      w.set({ nodes: prev.nodes, edges: prev.edges, active: prev.active, settings: prev.settings });
      await w.save();
      await syncWorkflowSchedules(w);
      await changes().updateOne({ _id: ch._id }, { $set: { undone: true, undoneAt: new Date(), undoReason: reason } });
      return text({ ok: true, workflow: w.name, restoredTo: 'before change ' + String(ch._id) });
    }

    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}

// --------------------------------------------------------------- JSON-RPC --
async function handleMessage(msg: any) {
  const id = msg?.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'svastha-automator', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications get no answer
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      try {
        return reply(await callTool(name, (msg.params?.arguments ?? {}) as Record<string, any>));
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `Tool failed: ${(e as Error).message}`;
        return reply({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return id === null ? null : fail(-32601, `Unknown method ${msg.method}`);
  }
}

export function mountMcp(app: Express) {
  const handler = async (req: Request, res: Response) => {
    const auth = authorised(req);
    if (!auth.ok) return res.status(auth.status ?? 401).json({ error: auth.message });
    if (req.method === 'GET') return res.status(405).set('Allow', 'POST').json({ error: 'Use POST (stateless MCP, JSON responses).' });
    const body = req.body;
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map(handleMessage))).filter(Boolean);
      return answers.length ? res.json(answers) : res.status(202).end();
    }
    const answer = await handleMessage(body);
    return answer ? res.json(answer) : res.status(202).end();
  };
  app.all('/mcp', handler);
  app.all('/mcp/:key', handler);
}
