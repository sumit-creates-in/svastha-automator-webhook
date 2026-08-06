export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface FieldNode {
  path: string;
  expression: string;
  label: string;
  type: FieldType;
  sample?: string;
  arrayLength?: number;
  childCount?: number;
  children?: FieldNode[];
  isLeaf: boolean;
}

export interface FieldGroup {
  key: string;
  label: string;
  description?: string;
  root: string;
  fields: FieldNode[];
  source: 'run' | 'pinned' | 'none';
  capturedAt?: string;
}

export interface FieldsResponse {
  groups: FieldGroup[];
  hasSample: boolean;
  helpers: Array<{ expression: string; description: string }>;
}

/** Colour and short label per JSON type, used for the badges in the tree. */
export const TYPE_STYLES: Record<FieldType, { label: string; className: string }> = {
  string: { label: 'Aa', className: 'bg-sky-50 text-sky-700 ring-sky-200' },
  number: { label: '12', className: 'bg-violet-50 text-violet-700 ring-violet-200' },
  boolean: { label: 'T/F', className: 'bg-amber-50 text-amber-700 ring-amber-200' },
  object: { label: '{ }', className: 'bg-slate-100 text-slate-600 ring-slate-200' },
  array: { label: '[ ]', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  null: { label: '—', className: 'bg-slate-100 text-slate-400 ring-slate-200' },
};

/** Depth-first list of every field, used for search. */
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

export function matchesSearch(field: FieldNode, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    field.path.toLowerCase().includes(needle) ||
    field.label.toLowerCase().includes(needle) ||
    (field.sample ?? '').toLowerCase().includes(needle)
  );
}
