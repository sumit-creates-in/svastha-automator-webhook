import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Pin,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import {
  TYPE_STYLES,
  flattenFields,
  matchesSearch,
  type FieldGroup,
  type FieldNode,
  type FieldsResponse,
} from '@/lib/fieldTypes';
import { cn, copyToClipboard, relativeTime } from '@/lib/utils';
import { useFieldTarget } from '@/store/fieldTarget';

interface Props {
  workflowId: string;
  nodeId: string;
  /** Opens the pin-data dialog for the previous step. */
  onPinData?: () => void;
  /** Runs the workflow so fields can be discovered. */
  onTestRun?: () => void;
}

function FieldRow({
  field,
  depth,
  search,
  onInsert,
}: {
  field: FieldNode;
  depth: number;
  search: string;
  onInsert: (field: FieldNode) => void;
}) {
  const hasChildren = Boolean(field.children?.length);
  // Auto-expand while searching so matches deeper in the tree are visible.
  const [open, setOpen] = useState(depth < 1);
  const expanded = search ? true : open;

  const style = TYPE_STYLES[field.type] ?? TYPE_STYLES.null;

  const visibleChildren = useMemo(() => {
    if (!field.children) return [];
    if (!search) return field.children;
    return field.children.filter(
      (child) =>
        matchesSearch(child, search) ||
        flattenFields(child.children ?? []).some((entry) => matchesSearch(entry, search)),
    );
  }, [field.children, search]);

  const selfMatches = matchesSearch(field, search);
  if (search && !selfMatches && visibleChildren.length === 0) return null;

  return (
    <div>
      <div
        className="group flex items-center gap-1.5 rounded-md py-1 pr-1 hover:bg-brand-50/60"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onInsert(field)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={`Insert ${field.expression}`}
        >
          <span
            className={cn(
              'shrink-0 rounded px-1 py-px font-mono text-[9px] font-bold ring-1',
              style.className,
            )}
          >
            {style.label}
          </span>

          <span className="truncate font-mono text-[12px] text-slate-700 group-hover:text-brand-700">
            {field.label}
          </span>

          {field.sample !== undefined ? (
            <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11px] text-slate-400">
              {field.sample}
            </span>
          ) : null}
        </button>
      </div>

      {expanded && visibleChildren.length > 0 ? (
        <div>
          {visibleChildren.map((child) => (
            <FieldRow
              key={child.path}
              field={child}
              depth={depth + 1}
              search={search}
              onInsert={onInsert}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GroupSection({
  group,
  search,
  onInsert,
}: {
  group: FieldGroup;
  search: string;
  onInsert: (field: FieldNode) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-slate-50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
        )}
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {group.label}
        </span>
        {group.source === 'pinned' ? (
          <span className="badge shrink-0 bg-amber-50 text-[10px] text-amber-700 ring-1 ring-amber-200">
            <Pin className="h-2.5 w-2.5" />
            pinned
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-0.5">
          {group.fields.map((field) => (
            <FieldRow
              key={field.path}
              field={field}
              depth={0}
              search={search}
              onInsert={onInsert}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Available Fields panel.
 *
 * Reads the sample payload the server captured from the last run (or whatever
 * the user pinned), and lets a field be dropped into the focused config input
 * with one click — no more guessing at `{{ $json.body.first_name }}`.
 */
export default function AvailableFields({ workflowId, nodeId, onPinData, onTestRun }: Props) {
  const [search, setSearch] = useState('');
  const [justInserted, setJustInserted] = useState<string | null>(null);
  const insert = useFieldTarget((state) => state.insert);
  const targetLabel = useFieldTarget((state) => state.label);

  const fields = useQuery({
    queryKey: ['fields', workflowId, nodeId],
    queryFn: async () =>
      (
        await api.get<FieldsResponse>(`/workflows/${workflowId}/fields`, {
          params: { nodeId },
        })
      ).data,
  });

  const handleInsert = async (field: FieldNode) => {
    const done = insert(field.expression);
    setJustInserted(field.path);
    setTimeout(() => setJustInserted(null), 1200);

    if (!done) {
      const copied = await copyToClipboard(field.expression);
      toast[copied ? 'success' : 'error'](
        copied
          ? 'Copied — click a field in the panel on the right, then paste'
          : 'Could not copy. Select the expression manually.',
      );
    }
  };

  const groups = (fields.data?.groups ?? []).filter((group) => group.fields.length > 0);
  const totalFields = groups.reduce(
    (sum, group) => sum + flattenFields(group.fields).length,
    0,
  );

  return (
    <div className="absolute right-[430px] top-0 z-20 flex h-full w-[320px] flex-col border-l border-slate-200 bg-white shadow-panel">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-semibold text-slate-900">Available fields</h2>
        </div>
        <button
          className="btn-ghost p-1.5"
          onClick={() => void fields.refetch()}
          title="Refresh"
          aria-label="Refresh fields"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', fields.isFetching && 'animate-spin')} />
        </button>
      </div>

      {totalFields > 0 ? (
        <div className="border-b border-slate-200 p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="input py-1.5 pl-8 text-xs"
              placeholder={`Search ${totalFields} fields`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            {targetLabel ? (
              <>
                Clicking a field inserts it into <strong>{targetLabel}</strong>.
              </>
            ) : (
              'Click into a field on the right, then click a value here to insert it.'
            )}
          </p>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {fields.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="text-brand-600" />
          </div>
        ) : totalFields === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
              <Database className="h-5 w-5 text-slate-400" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">No sample data yet</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              Run the webhook once to discover available fields.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Send a real request to your webhook URL, or press Test run — whatever arrives is
              remembered and listed here.
            </p>

            <div className="mt-4 flex flex-col gap-2">
              {onTestRun ? (
                <button className="btn-secondary btn-sm justify-center" onClick={onTestRun}>
                  <Play className="h-3.5 w-3.5" />
                  Test run now
                </button>
              ) : null}
              {onPinData ? (
                <button className="btn-ghost btn-sm justify-center" onClick={onPinData}>
                  <Pin className="h-3.5 w-3.5" />
                  Paste a sample instead
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <GroupSection
                key={group.key}
                group={group}
                search={search}
                onInsert={handleInsert}
              />
            ))}

            {search &&
            groups.every((group) =>
              flattenFields(group.fields).every((field) => !matchesSearch(field, search)),
            ) ? (
              <p className="px-2 py-6 text-center text-xs text-slate-500">
                Nothing matches “{search}”.
              </p>
            ) : null}
          </>
        )}
      </div>

      {totalFields > 0 ? (
        <div className="border-t border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              {groups[0]?.capturedAt ? `Captured ${relativeTime(groups[0].capturedAt)}` : 'Sample data'}
            </span>
            {onPinData ? (
              <button className="text-[11px] font-medium text-brand-600 hover:underline" onClick={onPinData}>
                Pin your own
              </button>
            ) : null}
          </div>
          {justInserted ? (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-emerald-600">
              <Check className="h-3 w-3" />
              Inserted
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
