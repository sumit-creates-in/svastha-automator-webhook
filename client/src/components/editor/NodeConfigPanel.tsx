import { useState } from 'react';
import { Check, Copy, CopyPlus, Info, Pin, PlayCircle, Settings2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import Icon from '@/components/Icon';
import PropertyRenderer from '@/components/editor/PropertyRenderer';
import { Field, Toggle } from '@/components/ui';
import type { Catalogue, NodeTypeDefinition, WorkflowNodeData } from '@/lib/types';
import { cn, copyToClipboard } from '@/lib/utils';

interface Props {
  node: WorkflowNodeData;
  definition?: NodeTypeDefinition;
  catalogue?: Catalogue;
  webhookUrl?: string;
  onChange: (patch: Partial<WorkflowNodeData>) => void;
  onDelete: () => void;
  onClose: () => void;
  onDuplicate?: () => void;
  onRunFromHere?: () => void;
  onPinData?: () => void;
}

export default function NodeConfigPanel({
  node,
  definition,
  catalogue,
  webhookUrl,
  onChange,
  onDelete,
  onClose,
  onDuplicate,
  onRunFromHere,
  onPinData,
}: Props) {
  const [tab, setTab] = useState<'settings' | 'advanced' | 'help'>('settings');
  const [copied, setCopied] = useState(false);

  const setParam = (name: string, value: unknown) => {
    onChange({ params: { ...node.params, [name]: value } });
  };

  const handleCopy = async () => {
    if (!webhookUrl) return;
    const ok = await copyToClipboard(webhookUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error('Could not copy — select the URL and copy manually.');
    }
  };

  return (
    <div className="absolute right-0 top-0 z-20 flex h-full w-[430px] flex-col border-l border-slate-200 bg-white shadow-panel">
      <div className="flex items-start gap-3 border-b border-slate-200 px-4 py-3">
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: definition?.color ?? '#64748b' }}
        >
          <Icon name={definition?.icon ?? 'Circle'} className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            className="w-full rounded border border-transparent px-1 py-0.5 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:outline-none"
            value={node.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
          <div className="px-1 text-xs text-slate-500">{definition?.displayName}</div>
        </div>
        <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
        {onRunFromHere ? (
          <button
            className="btn-ghost btn-sm"
            onClick={onRunFromHere}
            title="Run the workflow starting at this step, using the previous step's saved output"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Run from here
          </button>
        ) : null}
        {onPinData ? (
          <button
            className="btn-ghost btn-sm"
            onClick={onPinData}
            title="Paste a sample output so later steps can be built without running anything"
          >
            <Pin className={cn('h-3.5 w-3.5', node.pinnedData ? 'text-amber-500' : '')} />
            {node.pinnedData ? 'Pinned' : 'Pin data'}
          </button>
        ) : null}
        {onDuplicate ? (
          <button className="btn-ghost btn-sm" onClick={onDuplicate} title="Duplicate this step">
            <CopyPlus className="h-3.5 w-3.5" />
            Duplicate
          </button>
        ) : null}
      </div>

      <div className="flex gap-1 border-b border-slate-200 px-3 pt-2">
        {(
          [
            ['settings', 'Settings'],
            ['advanced', 'Advanced'],
            ['help', 'Expressions'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'rounded-t-lg px-3 py-2 text-xs font-medium transition',
              tab === key
                ? 'border-b-2 border-brand-600 text-brand-700'
                : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'settings' ? (
          <>
            {webhookUrl ? (
              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Webhook URL
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200">
                    {webhookUrl}
                  </code>
                  <button className="btn-secondary btn-sm shrink-0" onClick={handleCopy}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Point WordPress, a form plugin, or any other app at this URL. Save the workflow
                  after changing the path.
                </p>
              </div>
            ) : null}

            {definition ? (
              <PropertyRenderer
                properties={definition.properties}
                values={node.params ?? {}}
                onChange={setParam}
              />
            ) : (
              <p className="text-sm text-slate-500">This step type is not available.</p>
            )}
          </>
        ) : null}

        {tab === 'advanced' ? (
          <>
            <Field label="Notes" hint="Only visible here — useful for reminding yourself later.">
              <textarea
                className="input"
                rows={3}
                value={node.notes ?? ''}
                onChange={(event) => onChange({ notes: event.target.value })}
                placeholder="Why does this step exist?"
              />
            </Field>

            <div className="mb-4">
              <Toggle
                checked={!node.disabled}
                onChange={(value) => onChange({ disabled: !value })}
                label="Step is enabled"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                A disabled step is skipped, but the ones after it still run.
              </p>
            </div>

            <Field
              label="If this step fails"
              hint="Continuing passes an error object to the next step instead of stopping."
            >
              <select
                className="input"
                value={node.onError ?? 'stop'}
                onChange={(event) =>
                  onChange({ onError: event.target.value as 'stop' | 'continue' })
                }
              >
                <option value="stop">Stop the whole run</option>
                <option value="continue">Continue to the next step</option>
              </select>
            </Field>

            <div className="mb-4">
              <Toggle
                checked={Boolean(node.retryOnFail)}
                onChange={(value) => onChange({ retryOnFail: value })}
                label="Retry automatically on failure"
              />
            </div>

            <Field
              label="Give up after (seconds)"
              hint="A safety net. If this step has not finished by then it fails with an explanation, instead of leaving the run stuck. Blank uses the default of 90 seconds."
            >
              <input
                type="number"
                min={5}
                max={900}
                className="input"
                placeholder="90"
                value={node.timeoutMs ? Math.round(node.timeoutMs / 1000) : ''}
                onChange={(event) =>
                  onChange({
                    timeoutMs: event.target.value
                      ? Math.max(5, Number(event.target.value)) * 1000
                      : undefined,
                  })
                }
              />
            </Field>

            {node.retryOnFail ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max attempts">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className="input"
                    value={node.maxTries ?? 3}
                    onChange={(event) => onChange({ maxTries: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Wait between (ms)">
                  <input
                    type="number"
                    min={0}
                    max={60000}
                    step={500}
                    className="input"
                    value={node.waitBetweenTriesMs ?? 1000}
                    onChange={(event) =>
                      onChange({ waitBetweenTriesMs: Number(event.target.value) })
                    }
                  />
                </Field>
              </div>
            ) : null}

            <div className="mt-6 border-t border-slate-200 pt-4">
              <button className="btn-danger w-full" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                Delete this step
              </button>
            </div>
          </>
        ) : null}

        {tab === 'help' ? (
          <div className="space-y-4 text-sm">
            <div className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-800">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Wrap anything in <code className="font-mono">{'{{ }}'}</code> to pull in live data.
                For example <code className="font-mono">{'{{ $json.email }}'}</code> uses the email
                field from the previous step.
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Available data
              </h3>
              <div className="space-y-1.5">
                {(catalogue?.expressionVariables ?? []).map((variable) => (
                  <div key={variable.name} className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <code className="font-mono text-xs font-semibold text-brand-700">
                      {variable.name}
                    </code>
                    <p className="mt-0.5 text-xs text-slate-600">{variable.description}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Helper functions
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {(catalogue?.expressionHelpers ?? []).map((helper) => (
                  <code
                    key={helper}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700"
                  >
                    {helper}
                  </code>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Examples
              </h3>
              <ul className="space-y-1.5 text-xs text-slate-600">
                <li>
                  <code className="font-mono text-brand-700">{'{{ $json.body.name }}'}</code> — a
                  field from an incoming webhook
                </li>
                <li>
                  <code className="font-mono text-brand-700">
                    {'{{ $node["Clean up fields"].json.email }}'}
                  </code>{' '}
                  — output of an earlier step
                </li>
                <li>
                  <code className="font-mono text-brand-700">
                    {'{{ $fn.upper($json.city) }}'}
                  </code>{' '}
                  — transform a value
                </li>
                <li>
                  <code className="font-mono text-brand-700">
                    {'{{ $json.total > 5000 ? "big" : "small" }}'}
                  </code>{' '}
                  — inline logic
                </li>
              </ul>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <Settings2 className="h-3.5 w-3.5" />
          Changes are saved with the workflow
        </span>
        <span className="font-mono">{node.type}</span>
      </div>
    </div>
  );
}
