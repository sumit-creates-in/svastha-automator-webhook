/**
 * Field discovery — the data behind the "Available Fields" panel.
 *
 * Given a sample payload (a captured webhook body, a pinned sample, or an
 * earlier step's output) this walks it recursively and produces a tree of every
 * addressable value, each with the exact expression needed to reference it. That
 * removes the guesswork of writing `{{ $json.body.first_name }}` by hand.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface FieldNode {
  /** Dotted path within the payload, e.g. `body.customer.email`. */
  path: string;
  /** Ready-to-paste expression, e.g. `{{ $json.body.customer.email }}`. */
  expression: string;
  /** Just the last segment, for display. */
  label: string;
  type: FieldType;
  /** Short, human-readable preview of the value. */
  sample?: string;
  /** Number of elements, for arrays. */
  arrayLength?: number;
  /** Number of keys, for objects. */
  childCount?: number;
  children?: FieldNode[];
  isLeaf: boolean;
}

export interface FieldGroup {
  /** `trigger` for the payload that started the run, otherwise the node id. */
  key: string;
  label: string;
  description?: string;
  /** Expression prefix: `$json` for the previous step, `$node["Name"].json` otherwise. */
  root: string;
  fields: FieldNode[];
  /** Where the sample came from, so the UI can be honest about it. */
  source: 'run' | 'pinned' | 'none';
  capturedAt?: string;
}

const MAX_DEPTH = 8;
const MAX_FIELDS = 800;
const MAX_ARRAY_PREVIEW = 3;
const SAMPLE_LENGTH = 60;

/** Keys that are noisy in a webhook payload and rarely referenced. */
const NOISY_HEADER_KEYS = new Set([
  'connection',
  'accept-encoding',
  'cache-control',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
]);

export function detectType(value: unknown): FieldType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

export function previewValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `${keys.length} field${keys.length === 1 ? '' : 's'}`;
  }

  const text = String(value);
  if (text.length <= SAMPLE_LENGTH) return text;
  return `${text.slice(0, SAMPLE_LENGTH)}…`;
}

/** `a.b` but `a["odd key"]` when the segment is not a plain identifier. */
function joinPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  const escaped = key.replace(/"/g, '\\"');
  return parent ? `${parent}["${escaped}"]` : `["${escaped}"]`;
}

/**
 * Walks a value and returns its field tree.
 *
 * Arrays are described by their first element, since that is what a Loop step or
 * an `items[0]` reference will encounter.
 */
export function buildFieldTree(
  value: unknown,
  root = '$json',
  options: { depth?: number; parentPath?: string; budget?: { count: number } } = {},
): FieldNode[] {
  const depth = options.depth ?? 0;
  const parentPath = options.parentPath ?? '';
  const budget = options.budget ?? { count: 0 };

  if (depth >= MAX_DEPTH || budget.count >= MAX_FIELDS) return [];
  if (value === null || value === undefined || typeof value !== 'object') return [];

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value
        .slice(0, MAX_ARRAY_PREVIEW)
        .map((element, index) => [`[${index}]`, element] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const fields: FieldNode[] = [];

  for (const [key, child] of entries) {
    if (budget.count >= MAX_FIELDS) break;

    // Request headers are mostly noise; keep the ones people actually use.
    if (parentPath === 'headers' && NOISY_HEADER_KEYS.has(key.toLowerCase())) continue;

    const isArrayIndex = key.startsWith('[');
    const path = isArrayIndex ? `${parentPath}${key}` : joinPath(parentPath, key);
    const type = detectType(child);
    budget.count += 1;

    const node: FieldNode = {
      path,
      expression: `{{ ${root}${path.startsWith('[') ? '' : '.'}${path} }}`,
      label: key,
      type,
      sample: previewValue(child),
      isLeaf: type !== 'object' && type !== 'array',
    };

    if (type === 'array') {
      node.arrayLength = (child as unknown[]).length;
      node.children = buildFieldTree(child, root, {
        depth: depth + 1,
        parentPath: path,
        budget,
      });
    } else if (type === 'object') {
      node.childCount = Object.keys(child as object).length;
      node.children = buildFieldTree(child, root, {
        depth: depth + 1,
        parentPath: path,
        budget,
      });
    }

    fields.push(node);
  }

  return fields;
}

/** Flattens a tree into a searchable list of leaf-ish entries. */
export function flattenFields(fields: FieldNode[]): FieldNode[] {
  const out: FieldNode[] = [];
  const walk = (nodes: FieldNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(fields);
  return out;
}

/**
 * Escapes a step name for use inside `$node["..."]`.
 * Step names are user-supplied and may contain quotes.
 */
export function nodeRootExpression(nodeName: string): string {
  return `$node["${nodeName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"].json`;
}

export function buildFieldGroup(options: {
  key: string;
  label: string;
  description?: string;
  root: string;
  value: unknown;
  source: 'run' | 'pinned' | 'none';
  capturedAt?: string | Date;
}): FieldGroup {
  return {
    key: options.key,
    label: options.label,
    description: options.description,
    root: options.root,
    source: options.source,
    capturedAt:
      options.capturedAt instanceof Date
        ? options.capturedAt.toISOString()
        : options.capturedAt,
    fields: buildFieldTree(options.value, options.root),
  };
}

/**
 * Trims a captured payload before storing it.
 *
 * Sample data exists to describe shape, not to archive content — long strings and
 * long arrays are cut down so a single fat webhook cannot bloat the workflow
 * document or leak more personal data than necessary.
 */
export function summariseForSample(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_PREVIEW).map((entry) => summariseForSample(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = summariseForSample(child, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}
