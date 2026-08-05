import { Router } from 'express';
import { connectionDefinitions } from '../engine/connections';
import { defaultParamsFor, listNodeDefinitions, serialiseDefinition } from '../engine/registry';
import { expressionHelpers } from '../engine/expression';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

/**
 * The full catalogue the frontend needs: node types, credential types and the
 * helper functions available inside {{ }} expressions.
 */
router.get('/', (_req, res) => {
  const nodes = listNodeDefinitions().map((definition) => ({
    ...serialiseDefinition(definition),
    defaults: defaultParamsFor(definition.type),
  }));

  res.json({
    nodes,
    connections: connectionDefinitions.map(({ test, ...rest }) => rest),
    expressionHelpers: Object.keys(expressionHelpers).map((name) => `$fn.${name}()`),
    expressionVariables: [
      { name: '$json', description: 'Output of the previous step' },
      { name: '$trigger', description: 'The original trigger payload' },
      { name: '$node["Step name"].json', description: 'Output of any earlier step' },
      { name: '$vars', description: 'Workflow variables' },
      { name: '$now', description: 'Current time as an ISO string' },
      { name: '$timestamp', description: 'Current time in milliseconds' },
      { name: '$runId', description: 'Id of this run' },
      { name: '$workflowName', description: 'Name of the workflow' },
    ],
  });
});

export default router;
