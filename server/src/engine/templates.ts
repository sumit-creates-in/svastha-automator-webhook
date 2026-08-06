/**
 * Starter workflows.
 *
 * These exist so a new user gets a working, editable example rather than an
 * empty canvas — the recipes below cover what Uncanny Automator was typically
 * doing on a WordPress site.
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** What the user needs before this will run. */
  requires: string[];
  icon: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

const position = (x: number, y: number) => ({ x, y });

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'form-to-email',
    name: 'Form submission → email notification',
    description:
      'Receives a form post, tidies the fields, ignores submissions without an email address, and notifies your team.',
    requires: ['An SMTP connection'],
    icon: 'Mail',
    nodes: [
      {
        id: 'trigger',
        type: 'webhookTrigger',
        name: 'Form submitted',
        position: position(40, 220),
        params: { httpMethod: 'POST', authentication: 'none', responseMode: 'immediately' },
      },
      {
        id: 'clean',
        type: 'transform',
        name: 'Tidy the fields',
        position: position(330, 220),
        params: {
          mode: 'onlyDefined',
          fields: [
            { name: 'name', value: '{{ $fn.title($json.body.name) }}', type: 'string' },
            { name: 'email', value: '{{ $fn.lower($fn.trim($json.body.email)) }}', type: 'string' },
            { name: 'message', value: '{{ $json.body.message }}', type: 'string' },
          ],
          renames: [],
        },
      },
      {
        id: 'gate',
        type: 'filter',
        name: 'Has an email address',
        position: position(620, 220),
        params: {
          combinator: 'all',
          conditions: [{ left: '{{ $json.email }}', operator: 'contains', right: '@' }],
        },
      },
      {
        id: 'notify',
        type: 'sendEmail',
        name: 'Notify the team',
        position: position(910, 220),
        params: {
          to: '',
          subject: 'New enquiry from {{ $json.name }}',
          format: 'html',
          html:
            '<p><strong>{{ $json.name }}</strong> ({{ $json.email }}) wrote:</p>\n<blockquote>{{ $json.message }}</blockquote>',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'clean' },
      { id: 'e2', source: 'clean', target: 'gate' },
      { id: 'e3', source: 'gate', target: 'notify' },
    ],
  },
  {
    id: 'webhook-to-sheet',
    name: 'Webhook → Google Sheet row',
    description:
      'Logs every incoming submission as a new row in a spreadsheet. The classic "keep a record of everything" automation.',
    requires: ['A Google connection', 'A spreadsheet with a header row'],
    icon: 'Table2',
    nodes: [
      {
        id: 'trigger',
        type: 'webhookTrigger',
        name: 'New submission',
        position: position(40, 220),
        params: { httpMethod: 'POST', authentication: 'none', responseMode: 'immediately' },
      },
      {
        id: 'sheet',
        type: 'googleSheets',
        name: 'Add a row',
        position: position(360, 220),
        params: {
          operation: 'append',
          sheetName: 'Sheet1',
          headerRow: 1,
          columns: [
            { column: 'Date', value: '{{ $now }}' },
            { column: 'Name', value: '{{ $json.body.name }}' },
            { column: 'Email', value: '{{ $json.body.email }}' },
          ],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'sheet' }],
  },
  {
    id: 'fan-out',
    name: 'One webhook → email + spreadsheet + forward',
    description:
      'Shows branching: a single trigger driving three independent actions at once.',
    requires: ['An SMTP connection', 'A Google connection'],
    icon: 'Split',
    nodes: [
      {
        id: 'trigger',
        type: 'webhookTrigger',
        name: 'Order received',
        position: position(40, 240),
        params: { httpMethod: 'POST', authentication: 'none', responseMode: 'immediately' },
      },
      {
        id: 'email',
        type: 'sendEmail',
        name: 'Email the customer',
        position: position(380, 80),
        params: {
          to: '{{ $json.body.email }}',
          subject: 'We received your order',
          format: 'html',
          html: '<p>Thanks {{ $json.body.name }} — we are on it.</p>',
        },
      },
      {
        id: 'sheet',
        type: 'googleSheets',
        name: 'Log to the sheet',
        position: position(380, 240),
        params: {
          operation: 'append',
          sheetName: 'Orders',
          headerRow: 1,
          columns: [
            { column: 'Date', value: '{{ $now }}' },
            { column: 'Email', value: '{{ $json.body.email }}' },
          ],
        },
      },
      {
        id: 'forward',
        type: 'httpRequest',
        name: 'Forward to fulfilment',
        position: position(380, 400),
        params: {
          method: 'POST',
          url: 'https://example.com/hooks/orders',
          bodyType: 'json',
          bodyJson: '{\n  "order": {{ $fn.json($json.body) }}\n}',
          timeoutMs: 120000,
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'email' },
      { id: 'e2', source: 'trigger', target: 'sheet' },
      { id: 'e3', source: 'trigger', target: 'forward' },
    ],
  },
  {
    id: 'loop-line-items',
    name: 'Order with line items → one row each',
    description:
      'Loops over an array in the payload, writing a spreadsheet row per item, then sends a summary.',
    requires: ['A Google connection', 'An SMTP connection'],
    icon: 'Repeat',
    nodes: [
      {
        id: 'trigger',
        type: 'webhookTrigger',
        name: 'Order received',
        position: position(40, 240),
        params: { httpMethod: 'POST', authentication: 'none', responseMode: 'immediately' },
      },
      {
        id: 'loop',
        type: 'loopItems',
        name: 'Each line item',
        position: position(340, 240),
        params: { source: '{{ $json.body.line_items }}', maxItems: 250, wrapNonArray: true },
      },
      {
        id: 'row',
        type: 'googleSheets',
        name: 'Add a row',
        position: position(660, 150),
        params: {
          operation: 'append',
          sheetName: 'Line items',
          headerRow: 1,
          columns: [
            { column: 'SKU', value: '{{ $json.sku }}' },
            { column: 'Quantity', value: '{{ $json.quantity }}' },
          ],
        },
      },
      {
        id: 'summary',
        type: 'sendEmail',
        name: 'Send a summary',
        position: position(660, 360),
        params: {
          to: '',
          subject: 'Logged {{ $json.count }} line items',
          format: 'html',
          html: '<p>{{ $json.count }} line items were written to the sheet.</p>',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'row', sourceHandle: 'loop' },
      { id: 'e3', source: 'loop', target: 'summary', sourceHandle: 'done' },
    ],
  },
  {
    id: 'daily-report',
    name: 'Daily scheduled report',
    description:
      'Runs every morning, fetches data from an API, and emails it. A drop-in replacement for scheduled WordPress recipes.',
    requires: ['An SMTP connection'],
    icon: 'Clock',
    nodes: [
      {
        id: 'trigger',
        type: 'scheduleTrigger',
        name: 'Every weekday at 9am',
        position: position(40, 220),
        params: { mode: 'daily', minute: 0, hour: 9, timezone: 'Asia/Kolkata' },
      },
      {
        id: 'fetch',
        type: 'httpRequest',
        name: 'Fetch the numbers',
        position: position(340, 220),
        params: { method: 'GET', url: 'https://example.com/api/summary', timeoutMs: 120000 },
      },
      {
        id: 'email',
        type: 'sendEmail',
        name: 'Email the report',
        position: position(640, 220),
        params: {
          to: '',
          subject: 'Daily summary — {{ $fn.today() }}',
          format: 'html',
          html: '<pre>{{ $fn.json($json.body) }}</pre>',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'fetch' },
      { id: 'e2', source: 'fetch', target: 'email' },
    ],
  },
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return workflowTemplates.find((template) => template.id === id);
}
