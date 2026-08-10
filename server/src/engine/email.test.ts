/**
 * Email delivery and step-timeout tests.
 *
 * The scenario these exist for: a run that shows "Running" forever with only the
 * trigger recorded, because a step never returned.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { buildRawMessage, describeGmailError } from '../lib/gmail';
import { getTransporter, isGoogleCredential, clearTransporterCache } from './nodes/sendEmail';
import { runGraph, type GraphNode, type StepOutcome } from './graph';

test('a Google connection is recognised and routed to the Gmail API', () => {
  assert.equal(isGoogleCredential({ refreshToken: 'x' }), true);
  assert.equal(isGoogleCredential({ serviceAccountJson: '{}' }), true);
  assert.equal(isGoogleCredential({ privateKey: '---' }), true);
  assert.equal(isGoogleCredential({ host: 'smtp.gmail.com', password: 'p' }), false);
});

test('a MIME message is built and base64url encoded', async () => {
  const raw = await buildRawMessage({
    from: '"Svastha" <support@svastha.fit>',
    to: ['a@example.com'],
    subject: 'Booking confirmed',
    html: '<p>See you at 2:50 pm</p>',
  });

  // base64url uses - and _ and carries no padding, which the Gmail API requires.
  assert.match(raw, /^[A-Za-z0-9_-]+$/);

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /To: a@example\.com/);
  assert.match(decoded, /Subject: Booking confirmed/);
  assert.match(decoded, /support@svastha\.fit/);
  assert.match(decoded, /See you at 2:50 pm/);
});

test('recipients on every header make it into the message', async () => {
  const raw = await buildRawMessage({
    from: 'a@b.com',
    to: ['one@example.com', 'two@example.com'],
    cc: ['cc@example.com'],
    replyTo: 'reply@example.com',
    subject: 'Hi',
    text: 'Body',
  });

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /one@example\.com/);
  assert.match(decoded, /two@example\.com/);
  assert.match(decoded, /Cc: cc@example\.com/);
  assert.match(decoded, /Reply-To: reply@example\.com/);
});

test('Gmail failures explain the specific cause', () => {
  const delegation = {
    response: { status: 403, data: { error: { message: 'unauthorized_client' } } },
  };
  assert.match(describeGmailError(delegation), /domain-wide delegation/);

  const scope = {
    response: { status: 403, data: { error: { message: 'Request had insufficient scopes' } } },
  };
  assert.match(describeGmailError(scope), /gmail\.send/);

  const quota = { response: { status: 429, data: { error: { message: 'Too many requests' } } } };
  assert.match(describeGmailError(quota), /quota/);
});

test('the SMTP transport is created with timeouts', () => {
  clearTransporterCache();
  const transporter = getTransporter({
    host: 'smtp.example.com',
    port: 465,
    user: 'u',
    password: 'p',
  });

  // Without these a blackholed port leaves sendMail waiting indefinitely.
  const options = (transporter as unknown as { options: Record<string, unknown> }).options;
  assert.ok(Number(options.connectionTimeout) > 0, 'connectionTimeout must be set');
  assert.ok(Number(options.greetingTimeout) > 0, 'greetingTimeout must be set');
  assert.ok(Number(options.socketTimeout) > 0, 'socketTimeout must be set');
  clearTransporterCache();
});

test('SMTP to a port that never replies fails instead of hanging', async () => {
  // A server that accepts the connection and then says nothing at all — exactly
  // how a blocked or blackholed SMTP port behaves.
  const silent = net.createServer(() => {
    /* deliberately no greeting */
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const port = (silent.address() as net.AddressInfo).port;

  clearTransporterCache();
  const transporter = getTransporter({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'u',
    password: 'p',
    greetingTimeoutMs: 800,
    connectionTimeoutMs: 800,
    socketTimeoutMs: 800,
  });

  const started = Date.now();
  await assert.rejects(
    () => transporter.sendMail({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
    /timeout|Greeting never received|ETIMEDOUT/i,
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 8000, `should give up quickly, took ${elapsed}ms`);

  clearTransporterCache();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

test('a step that never returns is stopped rather than freezing the run', async () => {
  const nodes: GraphNode[] = [
    { id: 'trigger', type: 'webhookTrigger', name: 'Webhook', inputs: 0 },
    { id: 'email', type: 'sendEmail', name: 'Send Email', inputs: 1 },
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'email', sourceHandle: 'main', targetHandle: 'main' },
  ];

  // Mirrors the executor's per-step ceiling.
  const withStepTimeout = <T,>(promise: Promise<T>, ms: number, name: string) =>
    Promise.race([
      promise,
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error(`"${name}" did not finish within ${ms}ms`)), ms),
      ),
    ]);

  const result = await runGraph({
    nodes,
    edges,
    startNodeId: 'trigger',
    startData: { body: { name: 'Sachin' } },
    execute: async (node) =>
      withStepTimeout(
        new Promise<StepOutcome>(() => {
          /* never settles, like a blocked SMTP socket */
        }),
        300,
        node.name,
      ),
  });

  assert.equal(result.status, 'error', 'the run must conclude, not sit at Running');
  if (result.status === 'error') {
    assert.match(result.error, /did not finish within/);
    assert.match(result.error, /Send Email/);
  }
});

test('a slow but successful step still completes', async () => {
  const nodes: GraphNode[] = [
    { id: 'trigger', type: 'webhookTrigger', name: 'Webhook', inputs: 0 },
    { id: 'slow', type: 'httpRequest', name: 'Slow API', inputs: 1 },
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'slow', sourceHandle: 'main', targetHandle: 'main' },
  ];

  const result = await runGraph({
    nodes,
    edges,
    startNodeId: 'trigger',
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { kind: 'output', data: { ok: true } } as StepOutcome;
    },
  });

  assert.equal(result.status, 'success');
});
