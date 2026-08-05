import type { NodeProperty } from './types';

/**
 * Credential types. Each definition drives a form in the UI and is stored
 * AES-256-GCM encrypted. Add a new one here to support a new integration.
 */
export interface ConnectionDefinition {
  type: string;
  displayName: string;
  description: string;
  icon: string;
  properties: NodeProperty[];
  /** Fields safe to display in the connections list (never secrets). */
  previewFields: string[];
  /** Optional connectivity check. */
  test?: (config: Record<string, unknown>) => Promise<void>;
}

export const connectionDefinitions: ConnectionDefinition[] = [
  {
    type: 'smtp',
    displayName: 'SMTP (Email)',
    description:
      'Any SMTP mail server — Hostinger, Gmail, Zoho, Outlook, Amazon SES, Brevo and so on.',
    icon: 'Mail',
    previewFields: ['host', 'port', 'fromEmail', 'user'],
    properties: [
      {
        name: 'host',
        label: 'SMTP host',
        type: 'string',
        required: true,
        placeholder: 'smtp.hostinger.com',
      },
      { name: 'port', label: 'Port', type: 'number', default: 465, required: true },
      {
        name: 'secure',
        label: 'Use TLS/SSL (port 465)',
        type: 'boolean',
        default: true,
        description: 'Turn off for STARTTLS on port 587.',
      },
      { name: 'user', label: 'Username', type: 'string', required: true },
      { name: 'password', label: 'Password', type: 'string', required: true },
      {
        name: 'fromName',
        label: 'Default from name',
        type: 'string',
        placeholder: 'SVASTHA Automator',
      },
      {
        name: 'fromEmail',
        label: 'Default from address',
        type: 'string',
        required: true,
        placeholder: 'no-reply@yourdomain.com',
      },
      {
        name: 'rejectUnauthorized',
        label: 'Verify TLS certificate',
        type: 'boolean',
        default: true,
        description: 'Disable only for self-signed certificates on internal servers.',
      },
    ],
  },
  {
    type: 'httpHeaderAuth',
    displayName: 'HTTP Header Auth',
    description: 'Sends a fixed header with every request — API keys, bearer tokens, etc.',
    icon: 'KeyRound',
    previewFields: ['headerName'],
    properties: [
      {
        name: 'headerName',
        label: 'Header name',
        type: 'string',
        required: true,
        default: 'Authorization',
      },
      {
        name: 'headerValue',
        label: 'Header value',
        type: 'string',
        required: true,
        placeholder: 'Bearer sk_live_...',
      },
    ],
  },
  {
    type: 'httpBasicAuth',
    displayName: 'HTTP Basic Auth',
    description: 'Username and password sent as a Basic authorization header.',
    icon: 'Lock',
    previewFields: ['username'],
    properties: [
      { name: 'username', label: 'Username', type: 'string', required: true },
      { name: 'password', label: 'Password', type: 'string', required: true },
    ],
  },
  {
    type: 'queryAuth',
    displayName: 'Query Parameter Auth',
    description: 'Appends a secret query parameter, e.g. ?api_key=...',
    icon: 'Link2',
    previewFields: ['paramName'],
    properties: [
      { name: 'paramName', label: 'Parameter name', type: 'string', required: true, default: 'api_key' },
      { name: 'paramValue', label: 'Parameter value', type: 'string', required: true },
    ],
  },
];

export function getConnectionDefinition(type: string): ConnectionDefinition | undefined {
  return connectionDefinitions.find((definition) => definition.type === type);
}
