/**
 * Creates a demo workflow so a fresh install has something to look at.
 * Run with:  npm run seed --prefix server
 */
import { nanoid } from 'nanoid';
import { connectDatabase, disconnectDatabase } from '../db/connect';
import { logger } from '../lib/logger';
import { Workflow } from '../models/Workflow';

async function main(): Promise<void> {
  await connectDatabase();

  const name = 'Demo — Webhook to Email';
  const existing = await Workflow.findOne({ name });
  if (existing) {
    logger.info('Demo workflow already exists');
    await disconnectDatabase();
    return;
  }

  await Workflow.create({
    name,
    description:
      'Receives a form submission on a webhook, tidies the data, stops if there is no email, then sends a notification.',
    active: false,
    webhookId: nanoid(22),
    nodes: [
      {
        id: 'trigger',
        type: 'webhookTrigger',
        name: 'Form submitted',
        position: { x: 40, y: 200 },
        params: { httpMethod: 'POST', authentication: 'none', responseMode: 'immediately' },
      },
      {
        id: 'clean',
        type: 'transform',
        name: 'Clean up fields',
        position: { x: 340, y: 200 },
        params: {
          mode: 'onlyDefined',
          fields: [
            { name: 'name', value: '{{ $fn.title($json.body.name) }}', type: 'string' },
            { name: 'email', value: '{{ $fn.lower($fn.trim($json.body.email)) }}', type: 'string' },
            { name: 'message', value: '{{ $json.body.message }}', type: 'string' },
            { name: 'receivedAt', value: '{{ $now }}', type: 'string' },
          ],
        },
      },
      {
        id: 'gate',
        type: 'filter',
        name: 'Has an email address',
        position: { x: 640, y: 200 },
        params: {
          combinator: 'all',
          conditions: [{ left: '{{ $json.email }}', operator: 'contains', right: '@' }],
        },
      },
      {
        id: 'notify',
        type: 'sendEmail',
        name: 'Notify the team',
        position: { x: 940, y: 200 },
        params: {
          subject: 'New enquiry from {{ $json.name }}',
          format: 'html',
          html:
            '<p><strong>{{ $json.name }}</strong> ({{ $json.email }}) wrote:</p><blockquote>{{ $json.message }}</blockquote>',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'clean', sourceHandle: 'main' },
      { id: 'e2', source: 'clean', target: 'gate', sourceHandle: 'main' },
      { id: 'e3', source: 'gate', target: 'notify', sourceHandle: 'main' },
    ],
  });

  logger.info('Demo workflow created');
  await disconnectDatabase();
}

main().catch((error) => {
  logger.error({ err: error }, 'Seed failed');
  process.exit(1);
});
