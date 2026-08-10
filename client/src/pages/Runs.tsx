import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import PageHeader from '@/components/PageHeader';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Run, Workflow } from '@/lib/types';
import { formatDateTime, formatDuration } from '@/lib/utils';

const STATUSES = ['', 'success', 'error', 'running', 'queued', 'waiting', 'cancelled'];

export default function Runs() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [page, setPage] = useState(1);

  const workflows = useQuery({
    queryKey: ['workflows', 'all'],
    queryFn: async () => (await api.get<{ workflows: Workflow[] }>('/workflows')).data.workflows,
  });

  const retry = useMutation({
    mutationFn: async (runId: string) =>
      (
        await api.post<{ runId: string; startedFrom?: string; note?: string }>(
          `/runs/${runId}/retry`,
        )
      ).data,
    onSuccess: (data) => {
      toast.success(data.note ?? 'Started again with the same data');
      navigate(`/runs/${data.runId}`);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not run that again')),
  });

  const runs = useQuery({
    queryKey: ['runs', status, workflow, page],
    refetchInterval: 8000,
    queryFn: async () =>
      (
        await api.get<{ runs: Run[]; total: number }>('/runs', {
          params: { status: status || undefined, workflow: workflow || undefined, page, limit: 30 },
        })
      ).data,
  });

  const totalPages = Math.max(1, Math.ceil((runs.data?.total ?? 0) / 30));

  return (
    <div>
      <PageHeader
        title="Run history"
        description="Every execution, with the data each step received and produced."
        actions={
          <button className="btn-secondary" onClick={() => void runs.refetch()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      <div className="px-8 py-6">
        <div className="mb-4 flex flex-wrap gap-3">
          <select
            className="input max-w-[200px]"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === '' ? 'All statuses' : value}
              </option>
            ))}
          </select>

          <select
            className="input max-w-[280px]"
            value={workflow}
            onChange={(event) => {
              setWorkflow(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All workflows</option>
            {(workflows.data ?? []).map((item) => (
              <option key={item._id} value={item._id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        {runs.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="text-brand-600" />
          </div>
        ) : runs.data && runs.data.runs.length > 0 ? (
          <>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Workflow</th>
                    <th className="px-4 py-3 font-semibold">Started by</th>
                    <th className="px-4 py-3 font-semibold">Started</th>
                    <th className="px-4 py-3 font-semibold">Duration</th>
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.data.runs.map((run) => (
                    <tr key={run._id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-800">{run.workflowName}</td>
                      <td className="px-4 py-3 capitalize text-slate-600">{run.mode}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDateTime(run.createdAt)}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDuration(run.durationMs)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            className="btn-ghost btn-sm"
                            title="Run this again with the same data"
                            disabled={retry.isPending}
                            onClick={() => retry.mutate(run._id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Run again
                          </button>
                          <Link
                            to={`/runs/${run._id}`}
                            className="text-xs font-medium text-brand-600 hover:underline"
                          >
                            Details
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
                <span>
                  Page {page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn-secondary btn-sm"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={<Activity className="h-10 w-10" />}
            title="No runs to show"
            description="Once a workflow fires — from a webhook, a schedule, or a test run — it will appear here."
          />
        )}
      </div>
    </div>
  );
}
