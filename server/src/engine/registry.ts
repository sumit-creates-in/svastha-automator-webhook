import type { NodeDefinition } from './types';

import webhookTrigger from './nodes/webhookTrigger';
import scheduleTrigger from './nodes/scheduleTrigger';
import manualTrigger from './nodes/manualTrigger';
import httpRequest from './nodes/httpRequest';
import sendEmail from './nodes/sendEmail';
import transform from './nodes/transform';
import ifCondition from './nodes/ifCondition';
import filter from './nodes/filter';
import delay from './nodes/delay';
import code from './nodes/code';
import respondToWebhook from './nodes/respondToWebhook';
import googleSheets from './nodes/googleSheets';
import calculate from './nodes/calculate';
import loopItems from './nodes/loopItems';
import merge from './nodes/merge';

/**
 * The node catalogue.
 *
 * To add a capability in a future version:
 *   1. create `src/engine/nodes/<yourNode>.ts` exporting a NodeDefinition
 *   2. import it here and add it to the array below
 * The palette, the config form and validation update themselves.
 */
const definitions: NodeDefinition[] = [
  // Triggers
  webhookTrigger,
  scheduleTrigger,
  manualTrigger,
  // Actions
  httpRequest,
  sendEmail,
  googleSheets,
  respondToWebhook,
  // Data
  transform,
  calculate,
  code,
  // Logic
  ifCondition,
  filter,
  delay,
  loopItems,
  merge,
];

const registry = new Map<string, NodeDefinition>(definitions.map((d) => [d.type, d]));

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

export function requireNodeDefinition(type: string): NodeDefinition {
  const definition = registry.get(type);
  if (!definition) throw new Error(`Unknown node type "${type}"`);
  return definition;
}

export function listNodeDefinitions(): NodeDefinition[] {
  return [...registry.values()];
}

export function isTrigger(type: string): boolean {
  return registry.get(type)?.group === 'trigger';
}

/** Serialisable view of a definition for the frontend (drops the execute function). */
export function serialiseDefinition(definition: NodeDefinition) {
  const { execute, ...rest } = definition;
  return rest;
}

export function defaultParamsFor(type: string): Record<string, unknown> {
  const definition = registry.get(type);
  if (!definition) return {};
  const params: Record<string, unknown> = {};
  for (const property of definition.properties) {
    if (property.type === 'notice') continue;
    if (property.default !== undefined) params[property.name] = structuredClone(property.default);
  }
  return params;
}

export { definitions as nodeDefinitions };
