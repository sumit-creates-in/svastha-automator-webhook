import axios, { type AxiosRequestConfig, type Method } from 'axios';
import type { NodeDefinition } from '../types';

interface KeyValueRow {
  key?: string;
  value?: string;
}

function rowsToObject(rows: unknown): Record<string, string> {
  if (!Array.isArray(rows)) return {};
  const out: Record<string, string> = {};
  for (const row of rows as KeyValueRow[]) {
    if (row && typeof row.key === 'string' && row.key.trim()) {
      out[row.key.trim()] = row.value === undefined || row.value === null ? '' : String(row.value);
    }
  }
  return out;
}

/**
 * Turns an axios failure into a message that says what actually happened.
 *
 * This matters more than it looks. A timeout means *we* gave up waiting — the
 * request may well have been delivered and acted upon. Reporting that as a flat
 * "request failed" is how a workflow that successfully wrote a row ends up
 * marked as an error, so the wording here is deliberately explicit.
 */
export function describeRequestFailure(
  error: unknown,
  method: string,
  url: string,
  elapsedMs: number,
): Error {
  const err = error as { code?: string; message?: string; name?: string };
  const code = err?.code ?? '';
  const seconds = Math.round(elapsedMs / 100) / 10;

  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')) {
    return new Error(
      `${method} ${url} — the server did not reply within ${seconds}s, so the step was marked failed. ` +
        'The request may still have been received and processed. Raise "Timeout (ms)" on this step if the ' +
        'target is simply slow, and prefer an idempotent request before enabling retries.',
    );
  }

  if (err?.name === 'CanceledError' || code === 'ERR_CANCELED') {
    return new Error(
      `${method} ${url} — cancelled after ${seconds}s because the whole run hit its time limit. ` +
        'Raise the workflow timeout in Workflow settings.',
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`${method} ${url} — that hostname could not be resolved. Check the URL.`);
  }
  if (code === 'ECONNREFUSED') {
    return new Error(`${method} ${url} — the connection was refused. Is the service reachable?`);
  }
  if (code === 'CERT_HAS_EXPIRED' || code?.startsWith('UNABLE_TO_VERIFY')) {
    return new Error(
      `${method} ${url} — the TLS certificate could not be verified. Turn on "Ignore SSL errors" only if you trust this host.`,
    );
  }

  return new Error(`${method} ${url} — ${err?.message ?? String(error)}`);
}

export const httpRequest: NodeDefinition = {
  type: 'httpRequest',
  displayName: 'HTTP Request / Send Webhook',
  group: 'action',
  version: 1,
  description:
    'Calls any URL — send a webhook, POST JSON to another app, or fetch data from a REST API.',
  icon: 'Globe',
  color: '#0284c7',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'method',
      label: 'Method',
      type: 'select',
      default: 'POST',
      required: true,
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ label: m, value: m })),
    },
    {
      name: 'url',
      label: 'URL',
      type: 'string',
      required: true,
      placeholder: 'https://api.example.com/v1/contacts',
      description: 'Supports expressions, e.g. https://api.example.com/users/{{ $json.id }}',
    },
    {
      name: 'authConnection',
      label: 'Authentication',
      type: 'connection',
      connectionType: 'httpHeaderAuth,httpBasicAuth,queryAuth',
      description: 'Optional saved credential. Leave empty for public endpoints.',
    },
    {
      name: 'bodyType',
      label: 'Body type',
      type: 'select',
      default: 'json',
      options: [
        { label: 'JSON', value: 'json' },
        { label: 'Form data (url-encoded)', value: 'form' },
        { label: 'Raw text', value: 'raw' },
        { label: 'None', value: 'none' },
      ],
      displayOptions: { hide: { method: ['GET', 'HEAD'] } },
    },
    {
      name: 'bodyJson',
      label: 'JSON body',
      type: 'json',
      default: '{\n  "name": "{{ $json.name }}"\n}',
      rows: 10,
      displayOptions: { show: { bodyType: ['json'] }, hide: { method: ['GET', 'HEAD'] } },
    },
    {
      name: 'bodyFields',
      label: 'Form fields',
      type: 'keyValue',
      default: [],
      displayOptions: { show: { bodyType: ['form'] }, hide: { method: ['GET', 'HEAD'] } },
    },
    {
      name: 'bodyRaw',
      label: 'Raw body',
      type: 'text',
      rows: 6,
      displayOptions: { show: { bodyType: ['raw'] }, hide: { method: ['GET', 'HEAD'] } },
    },
    { name: 'queryParams', label: 'Query parameters', type: 'keyValue', default: [] },
    { name: 'headers', label: 'Headers', type: 'keyValue', default: [] },
    {
      name: 'timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      default: 120000,
      description:
        'How long to wait for a reply. Slow APIs (Google Sheets, Notion, large exports) can take well over 30 seconds — if you see "the server did not reply in time" errors on requests that actually worked, raise this.',
    },
    {
      name: 'ignoreSslErrors',
      label: 'Ignore SSL errors',
      type: 'boolean',
      default: false,
    },
    {
      name: 'neverError',
      label: 'Never fail on HTTP error status',
      type: 'boolean',
      default: false,
      description: 'When on, 4xx/5xx responses continue the workflow instead of failing the run.',
    },
    {
      name: 'responseFormat',
      label: 'Response format',
      type: 'select',
      default: 'auto',
      options: [
        { label: 'Auto-detect', value: 'auto' },
        { label: 'JSON', value: 'json' },
        { label: 'Text', value: 'text' },
      ],
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const method = String(params.method ?? 'POST').toUpperCase() as Method;
    const url = String(params.url ?? '').trim();
    if (!url) throw new Error('URL is required');

    const headers: Record<string, string> = rowsToObject(params.headers);
    const query: Record<string, string> = rowsToObject(params.queryParams);

    if (params.authConnection) {
      const credential = await ctx.getConnection(String(params.authConnection));
      if (credential.headerName) {
        headers[String(credential.headerName)] = String(credential.headerValue ?? '');
      } else if (credential.username !== undefined) {
        const basic = Buffer.from(
          `${credential.username}:${credential.password ?? ''}`,
          'utf8',
        ).toString('base64');
        headers.Authorization = `Basic ${basic}`;
      } else if (credential.paramName) {
        query[String(credential.paramName)] = String(credential.paramValue ?? '');
      }
    }

    let data: unknown;
    const bodyType = String(params.bodyType ?? 'json');
    if (!['GET', 'HEAD'].includes(method) && bodyType !== 'none') {
      if (bodyType === 'json') {
        const raw = params.bodyJson;
        if (typeof raw === 'string' && raw.trim()) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            throw new Error(
              `JSON body is not valid JSON after resolving expressions: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        } else if (raw && typeof raw === 'object') {
          data = raw;
        }
        headers['Content-Type'] ??= 'application/json';
      } else if (bodyType === 'form') {
        data = new URLSearchParams(rowsToObject(params.bodyFields)).toString();
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
      } else if (bodyType === 'raw') {
        data = params.bodyRaw ?? '';
      }
    }

    const config: AxiosRequestConfig = {
      url,
      method,
      headers,
      params: query,
      data,
      timeout: Number(params.timeoutMs ?? 30000),
      validateStatus: () => true,
      responseType: params.responseFormat === 'text' ? 'text' : 'json',
      maxRedirects: 5,
      signal: ctx.signal,
    };

    if (params.ignoreSslErrors) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('node:https') as typeof import('node:https');
      config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    const started = Date.now();
    let response;
    try {
      response = await axios.request(config);
    } catch (error) {
      throw describeRequestFailure(error, method, url, Date.now() - started);
    }
    const durationMs = Date.now() - started;

    const ok = response.status >= 200 && response.status < 300;
    ctx.log(`${method} ${url} -> ${response.status} (${durationMs}ms)`);

    if (!ok && !params.neverError) {
      const preview =
        typeof response.data === 'string'
          ? response.data.slice(0, 500)
          : JSON.stringify(response.data ?? {}).slice(0, 500);
      throw new Error(`Request failed with status ${response.status}: ${preview}`);
    }

    return {
      kind: 'output',
      data: {
        statusCode: response.status,
        success: ok,
        headers: response.headers as unknown as Record<string, unknown>,
        body: response.data,
        durationMs,
      },
    };
  },
};

export default httpRequest;
