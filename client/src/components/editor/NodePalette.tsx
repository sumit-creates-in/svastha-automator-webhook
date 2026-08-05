import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import Icon from '@/components/Icon';
import type { NodeTypeDefinition } from '@/lib/types';
import { cn } from '@/lib/utils';

const GROUP_LABELS: Record<string, string> = {
  trigger: 'Triggers — how the workflow starts',
  action: 'Actions — things that happen',
  transform: 'Data — change what gets passed on',
  logic: 'Logic — decide what runs next',
};

const GROUP_ORDER = ['trigger', 'action', 'transform', 'logic'];

export default function NodePalette({
  open,
  nodes,
  onPick,
  onClose,
  allowTriggers,
}: {
  open: boolean;
  nodes: NodeTypeDefinition[];
  onPick: (definition: NodeTypeDefinition) => void;
  onClose: () => void;
  allowTriggers: boolean;
}) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = nodes.filter((node) => {
      if (!allowTriggers && node.group === 'trigger') return false;
      if (!term) return true;
      return (
        node.displayName.toLowerCase().includes(term) ||
        node.description.toLowerCase().includes(term)
      );
    });

    return GROUP_ORDER.map((group) => ({
      group,
      items: filtered.filter((node) => node.group === group),
    })).filter((section) => section.items.length > 0);
  }, [nodes, search, allowTriggers]);

  if (!open) return null;

  return (
    <div className="absolute right-0 top-0 z-20 flex h-full w-[340px] flex-col border-l border-slate-200 bg-white shadow-panel">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Add a step</h2>
        <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-slate-200 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search steps"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {grouped.map((section) => (
          <div key={section.group} className="mb-5">
            <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {GROUP_LABELS[section.group] ?? section.group}
            </div>
            <div className="space-y-1">
              {section.items.map((definition) => (
                <button
                  key={definition.type}
                  onClick={() => onPick(definition)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border border-transparent p-2.5 text-left transition',
                    'hover:border-slate-200 hover:bg-slate-50',
                  )}
                >
                  <div
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
                    style={{ backgroundColor: definition.color }}
                  >
                    <Icon name={definition.icon} className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">
                      {definition.displayName}
                    </div>
                    <div className="mt-0.5 text-xs leading-snug text-slate-500">
                      {definition.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}

        {grouped.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-slate-500">
            Nothing matches “{search}”.
          </p>
        ) : null}
      </div>
    </div>
  );
}
