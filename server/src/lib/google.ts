import crypto from 'node:crypto';
import axios from 'axios';

/**
 * Google access-token helper.
 *
 * Supports the two credential styles the app offers:
 *
 *  - **Service account** — paste the JSON key, share the sheet with the service
 *    account's email. No consent screen, no token expiry to manage, nothing to
 *    re-authorise. This is the route recommended to non-technical users.
 *  - **OAuth 2.0** — the classic "Connect with Google" flow, acting as a real
 *    person. Needed when the data must belong to a human account.
 *
 * Access tokens live for an hour; they are cached in memory and refreshed a
 * minute early so a burst of steps does not hammer Google's token endpoint.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Everything the app can do with a Google account, requested together at
 * consent time so one connection covers both Sheets and email — nobody enjoys
 * re-authorising because a second feature needed another permission.
 */
export const GOOGLE_ALL_SCOPES = [
  ...GOOGLE_SHEETS_SCOPES,
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Scopes are part of the key: a Sheets token cannot be reused for Gmail. */
function cacheKey(credential: Record<string, unknown>, scopes: string[]): string {
  const identity =
    credential.clientEmail ?? credential.client_email ?? credential.refreshToken ?? 'google';
  return `${String(identity)}::${credential.impersonateUser ?? ''}::${scopes.join(',')}`;
}

/** Normalises a service-account key whether it was pasted whole or field by field. */
export function readServiceAccount(credential: Record<string, any>): {
  clientEmail: string;
  privateKey: string;
} {
  let clientEmail = credential.clientEmail;
  let privateKey = credential.privateKey;

  if (credential.serviceAccountJson) {
    try {
      const parsed =
        typeof credential.serviceAccountJson === 'string'
          ? JSON.parse(credential.serviceAccountJson)
          : credential.serviceAccountJson;
      clientEmail = parsed.client_email ?? clientEmail;
      privateKey = parsed.private_key ?? privateKey;
    } catch {
      throw new Error(
        'The service account JSON could not be read. Paste the whole file downloaded from Google Cloud, including the outer { }.',
      );
    }
  }

  if (!clientEmail || !privateKey) {
    throw new Error('The service account key is missing client_email or private_key.');
  }

  // Keys pasted through form fields often arrive with escaped newlines.
  return { clientEmail: String(clientEmail), privateKey: String(privateKey).replace(/\\n/g, '\n') };
}

async function fetchServiceAccountToken(
  credential: Record<string, any>,
  scopes: string[],
): Promise<CachedToken> {
  const { clientEmail, privateKey } = readServiceAccount(credential);

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiry = issuedAt + 3600;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: scopes.join(' '),
      aud: TOKEN_URL,
      exp: expiry,
      iat: issuedAt,
      ...(credential.impersonateUser ? { sub: String(credential.impersonateUser) } : {}),
    }),
  );

  let signature: string;
  try {
    signature = base64url(
      crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey),
    );
  } catch {
    throw new Error(
      'The service account private key is not valid. Re-download the JSON key from Google Cloud and paste it again.',
    );
  }

  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 },
  );

  return { token: data.access_token as string, expiresAt: Date.now() + 3540_000 };
}

async function fetchOAuthToken(credential: Record<string, any>): Promise<CachedToken> {
  if (!credential.refreshToken) {
    throw new Error(
      'This Google connection has not been authorised yet. Open Connections and click "Connect with Google".',
    );
  }

  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(credential.refreshToken),
      client_id: String(credential.clientId ?? ''),
      client_secret: String(credential.clientSecret ?? ''),
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 },
  );

  return { token: data.access_token as string, expiresAt: Date.now() + 3540_000 };
}

/** Returns a valid bearer token for the given saved Google credential. */
export async function getGoogleAccessToken(
  credential: Record<string, any>,
  scopes: string[] = GOOGLE_SHEETS_SCOPES,
): Promise<string> {
  const key = cacheKey(credential, scopes);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const isServiceAccount = Boolean(
    credential.serviceAccountJson || (credential.clientEmail && credential.privateKey),
  );

  let fresh: CachedToken;
  try {
    fresh = isServiceAccount
      ? await fetchServiceAccountToken(credential, scopes)
      : await fetchOAuthToken(credential);
  } catch (error) {
    throw new Error(`Google rejected the credentials: ${describeGoogleError(error)}`);
  }

  tokenCache.set(key, fresh);
  return fresh.token;
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

/** Builds the consent-screen URL for the "Connect with Google" button. */
export function buildGoogleAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: (options.scopes ?? GOOGLE_ALL_SCOPES).join(' '),
    // Both are required for Google to hand back a refresh token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: options.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Swaps the one-time code from the consent screen for a refresh token. */
export async function exchangeGoogleCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ refreshToken?: string; accessToken: string; scope?: string }> {
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 },
  );

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    scope: data.scope,
  };
}

/** Google's API errors are nested three levels deep; surface something readable. */
export function describeGoogleError(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: any } })?.response;
  const data = response?.data;

  const message =
    data?.error?.message ??
    data?.error_description ??
    (typeof data?.error === 'string' ? data.error : undefined) ??
    (error as Error)?.message ??
    'unknown error';

  if (response?.status === 403 && /permission|caller does not have/i.test(String(message))) {
    return `${message}. If you are using a service account, share the spreadsheet with its email address (Editor access).`;
  }
  if (response?.status === 404) {
    return `${message}. Check the spreadsheet ID and that the tab name matches exactly.`;
  }
  if (response?.status === 401) {
    return `${message}. The connection needs re-authorising.`;
  }

  return String(message);
}
