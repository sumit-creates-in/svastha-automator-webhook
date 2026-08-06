import { Types } from 'mongoose';
import { env } from '../config/env';
import { decryptJson } from '../lib/crypto';
import { toErrorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { Connection } from '../models/Connection';
import { Workflow } from '../models/Workflow';
import { getTransporter } from './nodes/sendEmail';
import { enqueueRun } from './queue';
import type { WorkflowNode } from './types';

export interface FailureContext {
  workflowId: string;
  workflowName: string;
  runId: string;
  error: string;
  errorNodeId?: string;
  mode: string;
}

/**
 * Runs whatever the workflow author asked for when a run fails: hand off to an
 * "error workflow", send an alert email, or both.
 *
 * Deliberately swallows its own failures — a broken alert must never turn into a
 * second incident, and the original error is already recorded on the run.
 */
export async function handleRunFailure(context: FailureContext): Promise<void> {
  try {
    const workflow = await Workflow.findById(context.workflowId).lean();
    if (!workflow) return;

    const settings = (workflow.settings ?? {}) as Record<string, any>;
    const failedNode = (workflow.nodes as unknown as WorkflowNode[])?.find(
      (node) => node.id === context.errorNodeId,
    );

    const payload = {
      workflow: { id: context.workflowId, name: context.workflowName },
      run: {
        id: context.runId,
        url: `${env.appUrl}/runs/${context.runId}`,
        mode: context.mode,
        failedAt: new Date().toISOString(),
      },
      error: {
        message: context.error,
        stepId: context.errorNodeId,
        stepName: failedNode?.name,
        stepType: failedNode?.type,
      },
    };

    await Promise.allSettled([
      triggerErrorWorkflow(settings.errorWorkflow, payload, context),
      sendErrorEmail(settings, payload, context),
    ]);
  } catch (error) {
    logger.warn(
      { runId: context.runId, err: toErrorMessage(error) },
      'Failure handler could not run',
    );
  }
}

async function triggerErrorWorkflow(
  errorWorkflowId: unknown,
  payload: Record<string, unknown>,
  context: FailureContext,
): Promise<void> {
  if (!errorWorkflowId || !Types.ObjectId.isValid(String(errorWorkflowId))) return;

  // Guard against a handler that fails and re-triggers itself forever.
  if (String(errorWorkflowId) === context.workflowId) {
    logger.warn({ workflow: context.workflowId }, 'A workflow cannot be its own error handler');
    return;
  }

  const handler = await Workflow.findById(errorWorkflowId);
  if (!handler || !handler.active) return;

  const nodes = handler.nodes as unknown as WorkflowNode[];
  const trigger = nodes.find((node) => node.type === 'manualTrigger') ?? nodes[0];
  if (!trigger) return;

  await enqueueRun({ workflow: handler, triggerNode: trigger, payload, mode: 'manual' });
  logger.info({ handler: handler.name, runId: context.runId }, 'Error workflow triggered');
}

async function sendErrorEmail(
  settings: Record<string, any>,
  payload: Record<string, any>,
  context: FailureContext,
): Promise<void> {
  const recipients = String(settings.errorEmailTo ?? '')
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
  if (recipients.length === 0) return;
  if (!settings.errorEmailConnection) return;

  const connection = await Connection.findById(settings.errorEmailConnection)
    .select('+data')
    .lean();
  if (!connection) return;

  const config = decryptJson<Record<string, any>>(connection.data as string);
  const transporter = getTransporter(config);

  const stepLine = payload.error.stepName
    ? `<p>It stopped at <strong>${escapeHtml(payload.error.stepName)}</strong>.</p>`
    : '';

  await transporter.sendMail({
    from: config.fromName
      ? `"${String(config.fromName).replace(/"/g, '')}" <${config.fromEmail}>`
      : String(config.fromEmail),
    to: recipients,
    subject: `Workflow failed: ${context.workflowName}`,
    html: `
      <p><strong>${escapeHtml(context.workflowName)}</strong> failed at ${new Date().toLocaleString()}.</p>
      ${stepLine}
      <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;white-space:pre-wrap;font-size:13px">${escapeHtml(
        context.error,
      )}</pre>
      <p><a href="${payload.run.url}">Open the run in SVASTHA Automator</a></p>
    `,
    text: `${context.workflowName} failed.\n\n${context.error}\n\n${payload.run.url}`,
  });

  logger.info({ runId: context.runId, recipients }, 'Failure alert sent');
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
