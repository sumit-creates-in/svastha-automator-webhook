/**
 * HTTP-level smoke tests. These run without MongoDB: they check that the app
 * boots, routes are wired, auth is enforced, and the HTTP Request node really
 * talks to a server.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from './app';
import httpRequest from './engine/nodes/httpRequest';
import { resolveValue } from './engine/expression';
import type { ExpressionScope, NodeExecutionContext } from './engine/types';

async function withServer<T>(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeCtx(params: Record<string, unknown>, input: Record<string, unknown>) {
  const scope: ExpressionScope = {
    $json: input,
    $trigger: input,
    $node: {},
    $vars: {},
    $runId: 'run',
    $workflowId: 'wf',
    $workflowName: 'wf',
    $now: new Date().toISOString(),
    $timestamp: Date.now(),
  };
  return {
    node: { id: 'n', type: 'httpRequest', name: 'HTTP', position: { x: 0, y: 0 }, params },
    params: resolveValue(params, scope),
    rawParams: params,
    input,
    scope,
    runId: 'run',
    workflowId: 'wf',
    getConnection: async () => ({}),
    resolve: (value: unknown) => resolveValue(value, scope),
    log: () => undefined,
    signal: new AbortController().signal,
  } as NodeExecutionContext;
}

test('the API boots and reports its health', async () => {
  const app = createApp();
  await withServer(app as unknown as http.RequestListener, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.ok('status' in body && 'database' in body);
  });
});

test('protected routes reject anonymous callers', async () => {
  const app = createApp();
  await withServer(app as unknown as http.RequestListener, async (baseUrl) => {
    for (const path of ['/api/nodes', '/api/workflows', '/api/runs', '/api/connections', '/api/users']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401, `${path} should require authentication`);
    }
  });
});

test('unknown API routes return a JSON 404', async () => {
  const app = createApp();
  await withServer(app as unknown as http.RequestListener, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.ok(body.error);
  });
});

test('the first-run status endpoint is public', async () => {
  const app = createApp();
  await withServer(app as unknown as http.RequestListener, async (baseUrl) => {
    // Without a database this times out into an error rather than hanging forever.
    const response = await fetch(`${baseUrl}/api/auth/status`);
    assert.ok([200, 500].includes(response.status));
  });
});

test('HTTP Request node sends JSON with resolved expressions', async () => {
  let received: { method?: string; url?: string; body?: string; headers?: http.IncomingHttpHeaders } = {};

  await withServer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received = {
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers,
        };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true, id: 'abc123' }));
      });
    },
    async (baseUrl) => {
      const ctx = makeCtx(
        {
          method: 'POST',
          url: `${baseUrl}/contacts`,
          bodyType: 'json',
          bodyJson: '{"email": "{{ $json.email }}", "score": {{ $json.score }}}',
          headers: [{ key: 'x-source', value: 'svastha' }],
          queryParams: [{ key: 'debug', value: '1' }],
          timeoutMs: 5000,
        },
        { email: 'sumit@example.com', score: 87 },
      );

      const result = await httpRequest.execute!(ctx);
      assert.equal(result.kind, 'output');
      if (result.kind !== 'output') return;

      assert.equal(result.data.statusCode, 201);
      assert.equal(result.data.success, true);
      assert.deepEqual(result.data.body, { created: true, id: 'abc123' });
    },
  );

  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/contacts?debug=1');
  assert.equal(received.headers?.['x-source'], 'svastha');
  assert.deepEqual(JSON.parse(received.body ?? '{}'), { email: 'sumit@example.com', score: 87 });
});

test('HTTP Request node fails loudly on a 500 unless told otherwise', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => httpRequest.execute!(makeCtx({ method: 'GET', url: baseUrl }, {})),
        /status 500/,
      );

      const tolerant = await httpRequest.execute!(
        makeCtx({ method: 'GET', url: baseUrl, neverError: true }, {}),
      );
      assert.equal(tolerant.kind === 'output' ? tolerant.data.statusCode : null, 500);
      assert.equal(tolerant.kind === 'output' ? tolerant.data.success : null, false);
    },
  );
});
