import { Router } from 'express';
import { z } from 'zod';
import { getConnectionDefinition } from '../engine/connections';
import { getTransporter } from '../engine/nodes/sendEmail';
import { decryptJson, encryptJson } from '../lib/crypto';
import { AppError, asyncHandler, toErrorMessage } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { Connection } from '../models/Connection';

const router = Router();
router.use(requireAuth);

const MASK = '••••••••';

function buildPreview(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const definition = getConnectionDefinition(type);
  const preview: Record<string, unknown> = {};
  for (const field of definition?.previewFields ?? []) {
    if (config[field] !== undefined) preview[field] = config[field];
  }
  return preview;
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

    const connection = await Connection.create({
      name: data.name,
      type: data.type,
      data: encryptJson(data.config),
      preview: buildPreview(data.type, data.config),
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
      const merged = mergeSecrets(data.config, existing);
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
