/**
 * Claude connector (src/mcp.ts) without MongoDB: the key check, the MCP handshake and the masking that must never
 * leak secrets or customer contact data.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from './app';
import { maskPersonal, maskSecrets } from './mcp';

async function withApp<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try { return await run(`http://127.0.0.1:${port}`); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const rpc = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('secrets are masked: header values, token fields, secret URL parts', () => {
  const masked = maskSecrets({
    url: 'https://x.up.railway.app/api/hooks/svastha-ticket-resolved-ab12cd?key=abc',
    other: 'https://api.example/v1/intake/webhook/supersecretvalue/x',
    sheet: 'https://script.google.com/macros/s/AKfyc123456789/exec',
    headers: [{ key: 'x-svastha-secret', value: 'efcf93d5' }, { key: 'Content-Type', value: 'application/json' }],
    auth: { token: 'tok123', expectedToken: 'abc', path: 'sales-lead' },
    body: 'Authorization: Bearer abc.def.ghi',
  }) as any;
  assert.equal(masked.url, 'https://x.up.railway.app/api/hooks/<key>?key=<hidden>');
  assert.equal(masked.other, 'https://api.example/v1/intake/webhook/<secret>/x');
  assert.equal(masked.sheet, 'https://script.google.com/macros/s/<script-id>/exec');
  assert.deepEqual(masked.headers, [{ key: 'x-svastha-secret', value: '<hidden>' }, { key: 'Content-Type', value: 'application/json' }]);
  assert.equal(masked.auth.token, '<hidden>');
  assert.equal(masked.auth.expectedToken, '<hidden>');
  assert.equal(masked.auth.path, 'sales-lead');
  assert.equal(masked.body, 'Authorization: Bearer <hidden>');
});

test('customer phones and emails are masked', () => {
  const m = maskPersonal({ phone: '+91 98765 43210', email: 'priya@example.com', note: 'call 9876543210 now' }) as any;
  assert.equal(m.phone, '<phone …10>');
  assert.equal(m.email, '<email>');
  assert.equal(m.note, 'call <phone …10> now');
});

test('the connector refuses calls without the right key', async () => {
  process.env.MCP_KEY = 'k'.repeat(32);
  await withApp(async (base) => {
    assert.equal((await rpc(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await rpc(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await rpc(base, `/mcp/${'x'.repeat(32)}`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  });
});

test('handshake and tool list work with the key (header or path)', async () => {
  process.env.MCP_KEY = 'k'.repeat(32);
  await withApp(async (base) => {
    const init: any = await (await rpc(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { Authorization: `Bearer ${'k'.repeat(32)}` })).json();
    assert.equal(init.result.serverInfo.name, 'svastha-automator');
    const tools: any = await (await rpc(base, `/mcp/${'k'.repeat(32)}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = tools.result.tools.map((t: { name: string }) => t.name);
    for (const n of ['automator_status', 'error_summary', 'get_workflow', 'get_run', 'update_step', 'undo_change']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n: string) => /test_run|send/i.test(n)), 'no tool may send messages');
    const note = await rpc(base, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: `Bearer ${'k'.repeat(32)}` });
    assert.equal(note.status, 202);
  });
});

test('without MCP_KEY set the connector is off', async () => {
  delete process.env.MCP_KEY;
  await withApp(async (base) => {
    assert.equal((await rpc(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer anything' })).status, 503);
  });
});
