import axios from 'axios';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { describeGoogleError, getGoogleAccessToken } from './google';

/**
 * Sending through the Gmail API rather than SMTP.
 *
 * Two reasons this is the better option on a hosted platform:
 *
 *  - **It works.** Providers routinely block or blackhole outbound ports 25, 465
 *    and 587. The Gmail API is ordinary HTTPS on 443, which is never blocked.
 *  - **No password is stored.** Authentication is an OAuth token or a service
 *    account key, both of which can be revoked centrally without touching any
 *    other system.
 */

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface GmailSendResult {
  messageId: string;
  threadId?: string;
  accepted: string[];
}

/** Builds an RFC 2822 message and base64url-encodes it for the API. */
export async function buildRawMessage(options: Mail.Options): Promise<string> {
  const composer = new MailComposer(options);
  const message = await composer.compile().build();
  return message.toString('base64url');
}

function recipients(value: Mail.Options['to']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return [String(value)];
}

/**
 * Sends one message. `credential` is a saved Google connection — either OAuth2
 * (client id/secret plus refresh token) or a service account key.
 */
export async function sendViaGmailApi(
  credential: Record<string, any>,
  options: Mail.Options,
  signal?: AbortSignal,
): Promise<GmailSendResult> {
  const token = await getGoogleAccessToken(credential, GMAIL_SCOPES);
  const raw = await buildRawMessage(options);

  try {
    const { data } = await axios.post(
      GMAIL_SEND_URL,
      { raw },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Generous, but bounded — the whole point is that a send cannot hang.
        timeout: 45_000,
        signal,
      },
    );

    return {
      messageId: data.id,
      threadId: data.threadId,
      accepted: [
        ...recipients(options.to),
        ...recipients(options.cc),
        ...recipients(options.bcc),
      ],
    };
  } catch (error) {
    throw new Error(`Gmail API: ${describeGmailError(error)}`);
  }
}

/** Confirms the credentials work and returns which mailbox they belong to. */
export async function verifyGmailAccess(
  credential: Record<string, any>,
): Promise<{ emailAddress: string }> {
  const token = await getGoogleAccessToken(credential, GMAIL_SCOPES);

  try {
    const { data } = await axios.get(GMAIL_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20_000,
    });
    return { emailAddress: data.emailAddress };
  } catch (error) {
    throw new Error(`Gmail API: ${describeGmailError(error)}`);
  }
}

/** Google's send errors have a few specific causes worth naming outright. */
export function describeGmailError(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: any } })?.response;
  const status = response?.status;
  const message = describeGoogleError(error);

  if (status === 403 && /delegation|unauthorized_client/i.test(String(message))) {
    return `${message}. A service account can only send Gmail with domain-wide delegation enabled, and the "Send as" address set on the connection.`;
  }
  if (status === 403 && /insufficient|scope/i.test(String(message))) {
    return `${message}. The connection is missing the gmail.send permission — reconnect it and approve sending.`;
  }
  if (status === 400 && /raw|invalid/i.test(String(message))) {
    return `${message}. Check the From address is one this Google account is allowed to send from.`;
  }
  if (status === 429) {
    return `${message}. Gmail is rate limiting — the daily send quota may have been reached.`;
  }

  return message;
}
