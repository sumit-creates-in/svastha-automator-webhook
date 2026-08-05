import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, Plus, Trash2 } from 'lucide-react';
import { Field, Toggle } from '@/components/ui';
import { api } from '@/lib/api';
import type { Connection, NodeProperty } from '@/lib/types';
import { cn } from '@/lib/utils';

interface RendererProps {
  properties: NodeProperty[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

/** Evaluates a property's displayOptions against the current values. */
export function isVisible(property: NodeProperty, values: Record<string, unknown>): boolean {
  const display = property.displayOptions;
  if (!display) return true;

  if (display.show) {
    for (const [key, allowed] of Object.entries(display.show)) {
      const current = values[key];
      if (!allowed.some((option) => String(option) === String(current ?? ''))) return false;
    }
  }
  if (display.hide) {
    for (const [key, blocked] of Object.entries(display.hide)) {
      const current = values[key];
      if (blocked.some((option) => String(option) === String(current ?? ''))) return false;
    }
  }
  return true;
}

function ConnectionPicker({
  property,
  value,
  onChange,
}: {
  property: NodeProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const allowed = (property.connectionType ?? '').split(',').map((type) => type.trim()).filter(Boolean);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: async () => (await api.get<{ connections: Connection[] }>('/connections')).data.connections,
  });

  const options = (connections.data ?? []).filter(
    (connection) => allowed.length === 0 || allowed.includes(connection.type),
  );

  return (
    <>
      <select
        className="input"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">— none —</option>
        {options.map((connection) => (
          <option key={connection._id} value={connection._id}>
            {connection.name}
          </option>
        ))}
      </select>
      {options.length === 0 && !connections.isLoading ? (
        <p className="mt-1.5 text-xs text-amber-600">
          No matching connections yet.{' '}
          <a href="/connections" target="_blank" rel="noreferrer" className="underline">
            Add one
          </a>
          .
        </p>
      ) : null}
    </>
  );
}

function KeyValueEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const rows = Array.isArray(value) ? (value as Array<{ key?: string; value?: string }>) : [];

  const update = (index: number, patch: Partial<{ key: string; value: string }>) => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="name"
            value={row.key ?? ''}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className="input flex-[1.5]"
            placeholder="value"
            value={row.value ?? ''}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="btn-ghost px-2 text-slate-400 hover:text-rose-600"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label="Remove row"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </button>
    </div>
  );
}

function CollectionEditor({
  property,
  value,
  onChange,
}: {
  property: NodeProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const fields = property.fields ?? [];

  const blank = useMemo(() => {
    const row: Record<string, unknown> = {};
    for (const field of fields) row[field.name] = field.default ?? '';
    return row;
  }, [fields]);

  const update = (index: number, name: string, next: unknown) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [name]: next } : row)));
  };

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
          <div className="flex items-start gap-2">
            <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(fields.length, 3)}, minmax(0, 1fr))` }}>
              {fields.map((field) => (
                <div key={field.name}>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">
                    {field.label}
                  </label>
                  {field.type === 'select' ? (
                    <select
                      className="input py-1.5 text-xs"
                      value={String(row[field.name] ?? field.default ?? '')}
                      onChange={(event) => update(index, field.name, event.target.value)}
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input py-1.5 text-xs"
                      placeholder={field.placeholder}
                      value={String(row[field.name] ?? '')}
                      onChange={(event) => update(index, field.name, event.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn-ghost mt-5 px-1.5 text-slate-400 hover:text-rose-600"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label="Remove row"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => onChange([...rows, { ...blank }])}
      >
        <Plus className="h-3.5 w-3.5" />
        Add row
      </button>
    </div>
  );
}

function SingleProperty({
  property,
  values,
  onChange,
}: {
  property: NodeProperty;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const value = values[property.name] ?? property.default ?? '';
  const set = (next: unknown) => onChange(property.name, next);

  if (property.type === 'notice') {
    return (
      <div className="mb-4 flex gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-800">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-semibold">{property.label}</div>
          {property.description ? <p className="mt-0.5">{property.description}</p> : null}
        </div>
      </div>
    );
  }

  if (property.type === 'boolean') {
    return (
      <div className="mb-4">
        <Toggle checked={Boolean(value)} onChange={set} label={property.label} />
        {property.description ? (
          <p className="mt-1.5 text-xs text-slate-500">{property.description}</p>
        ) : null}
      </div>
    );
  }

  return (
    <Field label={property.label} hint={property.description} required={property.required}>
      {property.type === 'select' ? (
        <select className="input" value={String(value)} onChange={(event) => set(event.target.value)}>
          {(property.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : property.type === 'number' ? (
        <input
          type="number"
          className="input"
          value={value === '' ? '' : Number(value)}
          placeholder={property.placeholder}
          onChange={(event) => set(event.target.value === '' ? '' : Number(event.target.value))}
        />
      ) : property.type === 'text' ? (
        <textarea
          className="input font-mono text-xs"
          rows={property.rows ?? 4}
          value={String(value)}
          placeholder={property.placeholder}
          onChange={(event) => set(event.target.value)}
        />
      ) : property.type === 'json' || property.type === 'code' ? (
        <textarea
          className={cn('code-area', 'resize-y')}
          rows={property.rows ?? 8}
          spellCheck={false}
          value={String(value)}
          placeholder={property.placeholder}
          onChange={(event) => set(event.target.value)}
        />
      ) : property.type === 'keyValue' ? (
        <KeyValueEditor value={value} onChange={set} />
      ) : property.type === 'collection' ? (
        <CollectionEditor property={property} value={value} onChange={set} />
      ) : property.type === 'connection' ? (
        <ConnectionPicker property={property} value={value} onChange={set} />
      ) : (
        <input
          className="input"
          value={String(value)}
          placeholder={property.placeholder}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );
}

/** Renders a whole property list from a node definition. */
export default function PropertyRenderer({ properties, values, onChange }: RendererProps) {
  return (
    <div>
      {properties
        .filter((property) => isVisible(property, values))
        .map((property) => (
          <SingleProperty
            key={property.name}
            property={property}
            values={values}
            onChange={onChange}
          />
        ))}
    </div>
  );
}
