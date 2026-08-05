import { runSandboxedCode } from '../sandbox';
import type { NodeDefinition } from '../types';

const DEFAULT_CODE = `// Everything from the previous step is in \`items\` / \`$json\`.
// Return an object — it becomes the output of this node.

const fullName = [$json.first_name, $json.last_name].filter(Boolean).join(' ');

return {
  ...$json,
  fullName,
  processedAt: new Date().toISOString(),
};
`;

export const code: NodeDefinition = {
  type: 'code',
  displayName: 'Code (JavaScript)',
  group: 'transform',
  version: 1,
  description:
    'Runs a small piece of JavaScript for anything the other nodes cannot express. Return an object to pass it downstream.',
  icon: 'Braces',
  color: '#6366f1',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'jsCode',
      label: 'JavaScript',
      type: 'code',
      language: 'javascript',
      default: DEFAULT_CODE,
      rows: 18,
      resolveExpressions: false,
      description:
        'Available: $json (previous step), $trigger, $node["Step name"].json, $vars, console.log(). async/await is supported. No network or filesystem access.',
    },
  ],

  async execute(ctx) {
    const source = String((ctx.rawParams as Record<string, unknown>).jsCode ?? '');
    if (!source.trim()) throw new Error('Code node is empty');

    const { value, logs } = await runSandboxedCode(source, {
      $json: ctx.input,
      items: ctx.input,
      $trigger: ctx.scope.$trigger,
      $node: ctx.scope.$node,
      $vars: ctx.scope.$vars,
      $now: ctx.scope.$now,
      $runId: ctx.runId,
      $workflowId: ctx.workflowId,
    });

    logs.forEach((line) => ctx.log(line));

    const data =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { result: value ?? null };

    return { kind: 'output', data };
  },
};

export default code;
