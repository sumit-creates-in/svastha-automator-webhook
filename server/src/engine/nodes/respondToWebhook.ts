import type { NodeDefinition } from '../types';

export const respondToWebhook: NodeDefinition = {
  type: 'respondToWebhook',
  displayName: 'Respond to Webhook',
  group: 'action',
  version: 1,
  description:
    'Defines exactly what the caller receives. Only used when the Webhook trigger is set to respond when the workflow finishes.',
  icon: 'Reply',
  color: '#0891b2',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'statusCode',
      label: 'Status code',
      type: 'number',
      default: 200,
    },
    {
      name: 'bodyType',
      label: 'Response body',
      type: 'select',
      default: 'json',
      options: [
        { label: 'JSON', value: 'json' },
        { label: 'Text', value: 'text' },
        { label: 'Pass through incoming data', value: 'passthrough' },
        { label: 'No content', value: 'none' },
      ],
    },
    {
      name: 'bodyJson',
      label: 'JSON',
      type: 'json',
      rows: 8,
      default: '{\n  "ok": true\n}',
      displayOptions: { show: { bodyType: ['json'] } },
    },
    {
      name: 'bodyText',
      label: 'Text',
      type: 'text',
      rows: 4,
      displayOptions: { show: { bodyType: ['text'] } },
    },
    { name: 'headers', label: 'Response headers', type: 'keyValue', default: [] },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const bodyType = String(params.bodyType ?? 'json');

    let body: unknown = null;
    if (bodyType === 'json') {
      try {
        body = typeof params.bodyJson === 'string' ? JSON.parse(params.bodyJson) : params.bodyJson;
      } catch (error) {
        throw new Error(
          `Response JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (bodyType === 'text') {
      body = String(params.bodyText ?? '');
    } else if (bodyType === 'passthrough') {
      body = ctx.input;
    }

    const headers: Record<string, string> = {};
    if (Array.isArray(params.headers)) {
      for (const row of params.headers as Array<{ key?: string; value?: string }>) {
        if (row?.key) headers[row.key] = String(row.value ?? '');
      }
    }

    return {
      kind: 'output',
      data: {
        ...ctx.input,
        __webhookResponse: {
          statusCode: Number(params.statusCode ?? 200),
          body,
          headers,
          hasBody: bodyType !== 'none',
        },
      },
    };
  },
};

export default respondToWebhook;
