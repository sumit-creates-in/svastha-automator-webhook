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
    type: 'googleServiceAccount',
    displayName: 'Google (Service Account)',
    description:
      'The simplest way to connect Google Sheets. Paste a JSON key once, then share each spreadsheet with the service account email. Nothing ever expires and nobody has to re-authorise.',
    icon: 'Table2',
    previewFields: ['clientEmail', 'projectId'],
    properties: [
      {
        name: 'setup',
        label: 'One-time setup',
        type: 'notice',
        description:
          '1. Go to console.cloud.google.com → create a project. 2. Enable the Google Sheets API. 3. IAM & Admin → Service Accounts → create one → Keys → Add key → JSON. 4. Paste the downloaded file below. 5. Share your spreadsheet with the service account email, as Editor.',
      },
      {
        name: 'serviceAccountJson',
        label: 'Service account JSON key',
        type: 'code',
        language: 'json',
        rows: 10,
        required: true,
        placeholder: '{\n  "type": "service_account",\n  "client_email": "...",\n  "private_key": "..."\n}',
        description: 'Paste the whole downloaded file, including the outer braces.',
      },
      {
        name: 'clientEmail',
        label: 'Service account email (filled in automatically)',
        type: 'string',
        description: 'Share your spreadsheets with this address.',
      },
    ],
  },
  {
    type: 'googleOAuth2',
    displayName: 'Google (Sign in)',
    description:
      'Connects as a real Google account, so files you create belong to you. Needs an OAuth client from Google Cloud once, then it is a single click per account.',
    icon: 'KeyRound',
    previewFields: ['account', 'scope'],
    properties: [
      {
        name: 'setup',
        label: 'One-time setup',
        type: 'notice',
        description:
          'In Google Cloud → APIs & Services → Credentials, create an OAuth client ID of type "Web application", and add this exact redirect URI: <APP_URL>/api/connections/oauth/google/callback',
      },
      { name: 'clientId', label: 'Client ID', type: 'string', required: true },
      { name: 'clientSecret', label: 'Client secret', type: 'string', required: true },
      {
        name: 'refreshToken',
        label: 'Refresh token',
        type: 'string',
        description:
          'Filled in automatically after you save and click "Connect with Google". Leave blank.',
      },
      { name: 'account', label: 'Connected account', type: 'string' },
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
