import type { NodeDefinition } from '../types';

export const webhookTrigger: NodeDefinition = {
  type: 'webhookTrigger',
  displayName: 'Webhook',
  group: 'trigger',
  version: 1,
  description:
    'Starts the workflow when data is POSTed (or GET) to a unique URL. Use this to receive data from forms, other apps, or your WordPress site.',
  icon: 'Webhook',
  color: '#0ea5e9',
  inputs: 0,
  outputs: [{ name: 'main', label: 'Output' }],
  triggerKind: 'webhook',
  properties: [
    {
      name: 'httpMethod',
      label: 'HTTP method',
      type: 'select',
      default: 'POST',
      options: [
        { label: 'POST', value: 'POST' },
        { label: 'GET', value: 'GET' },
        { label: 'PUT', value: 'PUT' },
        { label: 'PATCH', value: 'PATCH' },
        { label: 'Any', value: 'ANY' },
      ],
      description: 'Which HTTP verb this webhook accepts.',
    },
    {
      name: 'path',
      label: 'Custom path suffix',
      type: 'string',
      placeholder: 'contact-form',
      description:
        'Optional. Appended to the webhook URL so you can tell endpoints apart, e.g. /api/webhooks/<id>/contact-form',
    },
    {
      name: 'authentication',
      label: 'Authentication',
      type: 'select',
      default: 'none',
      options: [
        { label: 'None (URL is the secret)', value: 'none' },
        { label: 'Header token', value: 'header' },
        { label: 'HMAC SHA-256 signature', value: 'hmac' },
      ],
    },
    {
      name: 'authHeaderName',
      label: 'Header name',
      type: 'string',
      default: 'x-webhook-token',
      displayOptions: { show: { authentication: ['header', 'hmac'] } },
    },
    {
      name: 'authToken',
      label: 'Expected token / signing secret',
      type: 'string',
      displayOptions: { show: { authentication: ['header', 'hmac'] } },
      description:
        'For HMAC the sender must send hex(HMAC_SHA256(secret, rawBody)) in the header above.',
    },
    {
      name: 'responseMode',
      label: 'Respond',
      type: 'select',
      default: 'immediately',
      options: [
        {
          label: 'Immediately (202 Accepted)',
          value: 'immediately',
          description: 'Fastest. The caller gets a run id straight away.',
        },
        {
          label: 'When the workflow finishes',
          value: 'lastNode',
          description: 'The caller waits and receives the last node output, or a Respond node body.',
        },
      ],
    },
    {
      name: 'responseTimeoutMs',
      label: 'Max wait (ms)',
      type: 'number',
      default: 30000,
      displayOptions: { show: { responseMode: ['lastNode'] } },
    },
    {
      name: 'rawBody',
      label: 'Keep raw body',
      type: 'boolean',
      default: false,
      description: 'Adds the unparsed request body as {{ $json.rawBody }}.',
    },
    {
      name: 'notice',
      label: 'Webhook URL',
      type: 'notice',
      description:
        'Save the workflow to generate the URL, then copy it from the panel header. Incoming data is available as {{ $json.body.field }}, {{ $json.query.field }} and {{ $json.headers[\'header-name\'] }}.',
    },
  ],
};

export default webhookTrigger;
