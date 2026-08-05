import nodemailer, { type Transporter } from 'nodemailer';
import type { NodeDefinition } from '../types';

const transporterCache = new Map<string, Transporter>();

function cacheKey(config: Record<string, unknown>): string {
  return [config.host, config.port, config.user, config.secure].join('|');
}

export function getTransporter(config: Record<string, any>): Transporter {
  const key = cacheKey(config);
  const cached = transporterCache.get(key);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: String(config.host),
    port: Number(config.port ?? 465),
    secure: config.secure !== false,
    auth: config.user ? { user: String(config.user), pass: String(config.password ?? '') } : undefined,
    tls: { rejectUnauthorized: config.rejectUnauthorized !== false },
    pool: true,
    maxConnections: 3,
  });

  transporterCache.set(key, transporter);
  return transporter;
}

export function clearTransporterCache(): void {
  for (const transporter of transporterCache.values()) transporter.close();
  transporterCache.clear();
}

function splitAddresses(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

export const sendEmail: NodeDefinition = {
  type: 'sendEmail',
  displayName: 'Send Email',
  group: 'action',
  version: 1,
  description: 'Sends an email through any SMTP server. Supports HTML, plain text, CC/BCC and attachments by URL.',
  icon: 'Mail',
  color: '#e11d48',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'connection',
      label: 'SMTP connection',
      type: 'connection',
      connectionType: 'smtp',
      required: true,
      description: 'Create these under Connections. Credentials are stored encrypted.',
    },
    { name: 'to', label: 'To', type: 'string', required: true, placeholder: '{{ $json.email }}' },
    { name: 'cc', label: 'CC', type: 'string' },
    { name: 'bcc', label: 'BCC', type: 'string' },
    { name: 'replyTo', label: 'Reply-To', type: 'string' },
    {
      name: 'fromName',
      label: 'From name (override)',
      type: 'string',
      description: 'Leave blank to use the connection default.',
    },
    {
      name: 'fromEmail',
      label: 'From address (override)',
      type: 'string',
      description: 'Must be an address your SMTP server is allowed to send from.',
    },
    {
      name: 'subject',
      label: 'Subject',
      type: 'string',
      required: true,
      placeholder: 'New enquiry from {{ $json.name }}',
    },
    {
      name: 'format',
      label: 'Body format',
      type: 'select',
      default: 'html',
      options: [
        { label: 'HTML', value: 'html' },
        { label: 'Plain text', value: 'text' },
        { label: 'Both', value: 'both' },
      ],
    },
    {
      name: 'html',
      label: 'HTML body',
      type: 'code',
      language: 'html',
      rows: 12,
      default: '<p>Hello {{ $json.name }},</p>\n<p>Thanks for getting in touch.</p>',
      displayOptions: { show: { format: ['html', 'both'] } },
    },
    {
      name: 'text',
      label: 'Plain text body',
      type: 'text',
      rows: 8,
      displayOptions: { show: { format: ['text', 'both'] } },
    },
    {
      name: 'attachments',
      label: 'Attachments (URL)',
      type: 'collection',
      default: [],
      fields: [
        { name: 'filename', label: 'File name', type: 'string' },
        { name: 'url', label: 'File URL', type: 'string' },
      ],
      description: 'Files are fetched from the URL at send time.',
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    if (!params.connection) throw new Error('Select an SMTP connection');

    const credential = await ctx.getConnection(String(params.connection));
    const transporter = getTransporter(credential);

    const fromEmail = params.fromEmail || credential.fromEmail;
    if (!fromEmail) throw new Error('No from address configured on the connection or the node');
    const fromName = params.fromName || credential.fromName;

    const to = splitAddresses(params.to);
    if (to.length === 0) throw new Error('At least one recipient is required');

    const format = String(params.format ?? 'html');
    const attachments = Array.isArray(params.attachments)
      ? (params.attachments as Array<{ filename?: string; url?: string }>)
          .filter((a) => a?.url)
          .map((a) => ({ filename: a.filename || undefined, path: a.url as string }))
      : [];

    const info = await transporter.sendMail({
      from: fromName ? `"${String(fromName).replace(/"/g, '')}" <${fromEmail}>` : String(fromEmail),
      to,
      cc: splitAddresses(params.cc),
      bcc: splitAddresses(params.bcc),
      replyTo: params.replyTo ? String(params.replyTo) : undefined,
      subject: String(params.subject ?? ''),
      html: format === 'html' || format === 'both' ? String(params.html ?? '') : undefined,
      text: format === 'text' || format === 'both' ? String(params.text ?? '') : undefined,
      attachments,
    });

    ctx.log(`Email sent to ${to.join(', ')} (${info.messageId})`);

    return {
      kind: 'output',
      data: {
        sent: true,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
    };
  },
};

export default sendEmail;
