import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { getConnectionDefinition } from '../engine/connections';
import { getTransporter } from '../engine/nodes/sendEmail';
import { decryptJson, encryptJson } from '../lib/crypto';
import { AppError, asyncHandler, toErrorMessage } from '../lib/errors';
import {
  buildGoogleAuthUrl,
  describeGoogleError,
  exchangeGoogleCode,
  getGoogleAccessToken,
  readServiceAccount,
} from '../lib/google';
import { verifyGmailAccess } from '../lib/gmail';
import { requireAuth } from '../middleware/auth';
import { Connection } from '../models/Connection';

export function googleRedirectUri(): string {
  return `${env.appUrl}/api/connections/oauth/google/callback`;
}

/**
 * Short-lived, single-use OAuth state tokens.
 *
 * Kept in memory deliberately: they live for five minutes and losing them on a
 * redeploy simply means the user clicks Connect again.
 */
const oauthStates = new Map<string, { connectionId: string; expiresAt: number }>();

function issueOAuthState(connectionId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(token, { connectionId, expiresAt: Date.now() + 5 * 60 * 1000 });

  for (const [key, value] of oauthStates) {
    if (value.expiresAt < Date.now()) oauthStates.delete(key);
  }
  return token;
}

function consumeOAuthState(token: string): { connectionId: string } | null {
  const entry = oauthStates.get(token);
  if (!entry) return null;
  oauthStates.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { connectionId: entry.connectionId };
}

const router = Router();

const MASK = '••••••••';

/**
 * Google OAuth callback.
 *
 * Declared before `requireAuth` because Google redirects the browser here
 * directly. The `state` parameter is a signed, single-use token issued by the
 * authenticated /start route, so this endpoint cannot be driven by a stranger.
 */
router.get(
  '/oauth/google/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;

    const close = (title: string, message: string, ok = false) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f8fafc;color:#0f172a">
  <div style="text-align:center;max-width:420px;padding:32px">
    <div style="font-size:44px">${ok ? '&#10003;' : '&#9888;'}</div>
    <h1 style="font-size:18px;margin:12px 0 6px">${title}</h1>
    <p style="color:#64748b;font-size:14px;line-height:1.5">${message}</p>
    <p style="color:#94a3b8;font-size:12px;margin-top:20px">You can close this window.</p>
  </div>
  <script>setTimeout(function(){ window.close(); }, ${ok ? 1500 : 8000});</script>
</body>`);
    };

    if (oauthError) return close('Authorisation cancelled', `Google reported: ${oauthError}`);
    if (!code || !state) return close('Something went wrong', 'Google did not send an authorisation code.');

    const claim = consumeOAuthState(state);
    if (!claim) {
      return close('That link has expired', 'Please start the connection again from the Connections page.');
    }

    const connection = await Connection.findById(claim.connectionId).select('+data');
    if (!connection) return close('Connection not found', 'It may have been deleted.');

    const config = decryptJson<Record<string, any>>(connection.data as string);

    try {
      const tokens = await exchangeGoogleCode({
        code,
        clientId: String(config.clientId ?? ''),
        clientSecret: String(config.clientSecret ?? ''),
        redirectUri: googleRedirectUri(),
      });

      if (!tokens.refreshToken) {
        return close(
          'Google did not return a refresh token',
          'This usually means the account was already connected. Remove SVASTHA Automator from your Google account permissions and try again.',
        );
      }

      const merged = { ...config, refreshToken: tokens.refreshToken, scope: tokens.scope };
      connection.set('data', encryptJson(merged));
      connection.set('preview', { ...(connection.preview ?? {}), scope: tokens.scope });
      connection.set('lastTestedAt', new Date());
      connection.set('lastTestOk', true);
      connection.set('lastTestError', undefined);
      await connection.save();

      return close('Google connected', 'You can now use this account in your workflows.', true);
    } catch (error) {
      return close('Google refused the connection', describeGoogleError(error));
    }
  }),
);

router.use(requireAuth);

/** Starts the consent flow for a saved Google OAuth connection. */
router.post(
  '/:id/oauth/google/start',
  asyncHandler(async (req, res) => {
    const connection = await Connection.findById(req.params.id).select('+data');
    if (!connection) throw AppError.notFound('Connection not found');
    if (connection.type !== 'googleOAuth2') {
      throw AppError.badRequest('That connection does not use Google sign-in');
    }

    const config = decryptJson<Record<string, any>>(connection.data as string);
    if (!config.clientId || !config.clientSecret) {
      throw AppError.badRequest('Add the Client ID and Client secret first, then save.');
    }

    const url = buildGoogleAuthUrl({
      clientId: String(config.clientId),
      redirectUri: googleRedirectUri(),
      state: issueOAuthState(String(connection._id)),
    });

    res.json({ url, redirectUri: googleRedirectUri() });
  }),
);

function buildPreview(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const definition = getConnectionDefinition(type);
  const preview: Record<string, unknown> = {};
  for (const field of definition?.previewFields ?? []) {
    if (config[field] !== undefined && config[field] !== '') preview[field] = config[field];
  }
  return preview;
}

/**
 * Pulls the identifying fields out of a pasted service-account key so the user
 * can see which email to share their spreadsheet with, without us ever showing
 * the private key back to them.
 */
function enrichGoogleConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type !== 'googleServiceAccount' || !config.serviceAccountJson) return config;

  try {
    const raw = config.serviceAccountJson;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
    return {
      ...config,
      clientEmail: parsed.client_email ?? config.clientEmail,
      privateKey: parsed.private_key ?? config.privateKey,
      projectId: parsed.project_id ?? config.projectId,
    };
  } catch {
    throw AppError.badRequest(
      'That does not look like a valid service account JSON key. Paste the whole file you downloaded from Google Cloud.',
    );
  }
}

/** Replaces masked values with the stored secret so partial updates work. */
function mergeSecrets(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === MASK || value === '') {
      if (existing[key] !== undefined) merged[key] = existing[key];
    }
  }
  return merged;
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const connections = await Connection.find().sort({ type: 1, name: 1 });
    res.json({ connections: connections.map((c) => c.toJSON()) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1, 'Give the connection a name'),
      type: z.string().min(1),
      config: z.record(z.unknown()),
    });
    const data = schema.parse(req.body);

    const definition = getConnectionDefinition(data.type);
    if (!definition) throw AppError.badRequest(`Unknown connection type "${data.type}"`);

    for (const property of definition.properties) {
      if (property.required && !data.config[property.name]) {
        throw AppError.badRequest(`${property.label} is required`);
      }
    }

    const config = enrichGoogleConfig(data.type, data.config);

    const connection = await Connection.create({
      name: data.name,
      type: data.type,
      data: encryptJson(config),
      preview: buildPreview(data.type, config),
      createdBy: req.user!.id,
    });

    res.status(201).json({ connection: connection.toJSON() });
  }),
);

/** Returns the config with secrets masked, so the edit form can be pre-filled. */
router.get(
  '/:id/config',
  asyncHandler(async (req, res) => {
    const connection = await Connection.findById(req.params.id).select('+data');
    if (!connection) throw AppError.notFound('Connection not found');

    const config = decryptJson<Record<string, unknown>>(connection.data as string);
    const definition = getConnectionDefinition(connection.type);
    const secretNames = new Set(
      (definition?.properties ?? [])
        .filter((property) => /password|secret|token|value/i.test(property.name))
        .map((property) => property.name),
    );

    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      masked[key] = secretNames.has(key) && value ? MASK : value;
    }

    res.json({ config: masked });
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      config: z.record(z.unknown()).optional(),
    });
    const data = schema.parse(req.body);

    const connection = await Connection.findById(req.params.id).select('+data');
    if (!connection) throw AppError.notFound('Connection not found');

    if (data.name) connection.set('name', data.name);

    if (data.config) {
      const existing = decryptJson<Record<string, unknown>>(connection.data as string);
      const merged = enrichGoogleConfig(connection.type, mergeSecrets(data.config, existing));
      connection.set('data', encryptJson(merged));
      connection.set('preview', buildPreview(connection.type, merged));
    }

    await connection.save();
    res.json({ connection: connection.toJSON() });
  }),
);

router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const connection = await Connection.findById(req.params.id).select('+data');
    if (!connection) throw AppError.notFound('Connection not found');

    const config = decryptJson<Record<string, any>>(connection.data as string);
    let ok = true;
    let error: string | undefined;

    try {
      if (connection.type === 'smtp') {
        await getTransporter(config).verify();
      } else if (connection.type === 'googleServiceAccount') {
        readServiceAccount(config);
        await getGoogleAccessToken(config);

        // Only meaningful once an address to send as has been set.
        if (config.impersonateUser) {
          const profile = await verifyGmailAccess(config);
          connection.set('preview', {
            ...(connection.preview ?? {}),
            sendsAs: profile.emailAddress,
          });
        }
      } else if (connection.type === 'googleOAuth2') {
        if (!config.refreshToken) {
          throw new Error('Not authorised yet — click "Connect with Google".');
        }
        const profile = await verifyGmailAccess(config);
        connection.set('preview', {
          ...(connection.preview ?? {}),
          account: profile.emailAddress,
        });
      } else {
        // Credential types without a live endpoint just validate their shape.
        const definition = getConnectionDefinition(connection.type);
        for (const property of definition?.properties ?? []) {
          if (property.required && !config[property.name]) {
            throw new Error(`${property.label} is missing`);
          }
        }
      }
    } catch (err) {
      ok = false;
      error = toErrorMessage(err);
    }

    connection.set('lastTestedAt', new Date());
    connection.set('lastTestOk', ok);
    connection.set('lastTestError', error);
    await connection.save();

    res.json({ ok, error });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const connection = await Connection.findById(req.params.id);
    if (!connection) throw AppError.notFound('Connection not found');
    await connection.deleteOne();
    res.json({ ok: true });
  }),
);

export default router;
