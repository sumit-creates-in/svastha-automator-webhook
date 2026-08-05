import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, EyeOff, XCircle } from 'lucide-react';
import Icon from '@/components/Icon';
import type { NodeTypeDefinition } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  definition?: NodeTypeDefinition;
  disabled?: boolean;
  hasIssue?: boolean;
  issueMessage?: string;
  runStatus?: 'success' | 'error' | 'skipped' | 'stopped' | 'waiting';
  subtitle?: string;
}

function FlowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as FlowNodeData;
  const definition = nodeData.definition;
  const isTrigger = definition?.group === 'trigger';
  const outputs = definition?.outputs ?? [{ name: 'main', label: 'Output' }];
  const color = definition?.color ?? '#64748b';

  return (
    <div
      className={cn(
        'group relative w-[230px] rounded-xl border-2 bg-white shadow-card transition',
        selected ? 'border-brand-500 shadow-panel' : 'border-slate-200 hover:border-slate-300',
        nodeData.disabled && 'opacity-50',
        isTrigger && 'rounded-l-[28px]',
      )}
    >
      {definition && definition.inputs > 0 ? (
        <Handle type="target" position={Position.Left} id="in" />
      ) : null}

      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: color }}
        >
          <Icon name={definition?.icon ?? 'Circle'} className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-slate-800">
            {nodeData.label}
          </div>
          <div className="truncate text-[11px] text-slate-500">
            {nodeData.subtitle || definition?.displayName || 'Unknown step'}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-1">
          {nodeData.disabled ? <EyeOff className="h-3.5 w-3.5 text-slate-400" /> : null}
          {nodeData.hasIssue ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-label={nodeData.issueMessage} />
          ) : null}
          {nodeData.runStatus === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : null}
          {nodeData.runStatus === 'error' ? <XCircle className="h-4 w-4 text-rose-500" /> : null}
        </div>
      </div>

      {outputs.length > 1 ? (
        <div className="border-t border-slate-100">
          {outputs.map((output) => (
            <div
              key={output.name}
              className={cn(
                'relative px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide',
                output.name === 'true' && 'text-emerald-600',
                output.name === 'false' && 'text-rose-500',
                output.name !== 'true' && output.name !== 'false' && 'text-slate-400',
              )}
            >
              {output.label}
              <Handle type="source" position={Position.Right} id={output.name} />
            </div>
          ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Right} id={outputs[0]?.name ?? 'main'} />
      )}
    </div>
  );
}

export default memo(FlowNodeComponent);
