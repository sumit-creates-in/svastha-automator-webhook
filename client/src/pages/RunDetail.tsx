import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import PageHeader from '@/components/PageHeader';
import { JsonViewer, Spinner, StatusBadge } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Run } from '@/lib/types';
import { formatDateTime, formatDuration } from '@/lib/utils';

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<number | null>(0);

  const run = useQuery({
    queryKey: ['run', id],
    refetchInterval: (query) => {
      const status = (query.state.data as Run | undefined)?.status;
      return status === 'running' || status === 'queued' ? 1500 : false;
    },
    queryFn: async () => (await api.get<{ run: Run }>(`/runs/${id}`)).data.run,
  });

  const retry = useMutation({
    mutationFn: async () => (await api.post<{ runId: string }>(`/runs/${id}/retry`)).data.runId,
    onSuccess: (runId) => {
      toast.success('Re-running with the same data');
      navigate(`/runs/${runId}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const cancel = useMutation({
    mutationFn: async () => api.post(`/runs/${id}/cancel`),
    onSuccess: () => {
      toast.success('Run cancelled');
      void run.refetch();
    },
  });

  if (run.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand-600" />
      </div>
    );
  }

  if (!run.data) {
    return <div className="p-8 text-sm text-slate-500">This run no longer exists.</div>;
  }

  const data = run.data;
  const inProgress = data.status === 'running' || data.status === 'queued' || data.status === 'waiting';

  return (
    <div>
      <PageHeader
        title={data.workflowName}
        description={`${data.mode} run · ${formatDateTime(data.createdAt)}`}
        actions={
          <>
            <Link to="/runs" className="btn-ghost">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
            {inProgress ? (
              <button className="btn-secondary" onClick={() => cancel.mutate()}>
                <Ban className="h-4 w-4" />
                Cancel
              </button>
            ) : null}
            <button className="btn-primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? <Spinner /> : <RotateCcw className="h-4 w-4" />}
              Run again
            </button>
          </>
        }
      />

      <div className="px-8 py-6">
        <div className="mb-6 grid gap-4 sm:grid-cols-4">
          <div className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
            <div className="mt-2">
              <StatusBadge status={data.status} />
            </div>
          </div>
          <div className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Duration</div>
            <div className="mt-2 text-lg font-semibold text-slate-900">
              {formatDuration(data.durationMs)}
            </div>
          </div>
          <div className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps</div>
            <div className="mt-2 text-lg font-semibold text-slate-900">{data.steps.length}</div>
          </div>
          <div className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Workflow</div>
            <Link
              to={`/workflows/${data.workflow}`}
              className="mt-2 block truncate text-sm font-medium text-brand-600 hover:underline"
            >
              Open editor
            </Link>
          </div>
        </div>

        {data.error ? (
          <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4">
            <div className="text-sm font-semibold text-rose-800">The run stopped with an error</div>
            <p className="mt-1 font-mono text-xs text-rose-700">{data.error}</p>
          </div>
        ) : null}

        <h2 className="mb-3 text-sm font-semibold text-slate-800">Steps</h2>
        <div className="space-y-2">
          {data.steps.map((step, index) => (
            <div key={`${step.nodeId}-${index}`} className="card overflow-hidden">
              <button
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                onClick={() => setExpanded(expanded === index ? null : index)}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                  {index + 1}
                </span>
                <StatusBadge status={step.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{step.nodeName}</div>
                  <div className="text-xs text-slate-500">{step.nodeType}</div>
                </div>
                {step.tries && step.tries > 1 ? (
                  <span className="badge bg-amber-50 text-amber-700">{step.tries} tries</span>
                ) : null}
                <span className="shrink-0 text-xs text-slate-400">
                  {formatDuration(step.durationMs)}
                </span>
              </button>

              {expanded === index ? (
                <div className="grid gap-4 border-t border-slate-100 bg-slate-50 p-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Input
                    </div>
                    <JsonViewer value={step.input} />
                  </div>
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {step.error ? 'Error' : 'Output'}
                    </div>
                    {step.error ? (
                      <pre className="max-h-80 overflow-auto rounded-lg bg-rose-100 p-3 font-mono text-xs text-rose-800">
                        {step.error}
                      </pre>
                    ) : (
                      <JsonViewer value={step.output} />
                    )}
                  </div>
                  {step.logs && step.logs.length > 0 ? (
                    <div className="lg:col-span-2">
                      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Logs
                      </div>
                      <pre className="max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                        {step.logs.join('\n')}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
