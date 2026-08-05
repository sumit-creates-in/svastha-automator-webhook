import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, Clock, Plus, XCircle, Zap } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import type { Run, Workflow } from '@/lib/types';
import { formatDuration, relativeTime } from '@/lib/utils';

interface Summary {
  last24h: Record<string, number>;
  workflows: number;
  activeWorkflows: number;
  queue: { pending: number; active: number };
}

function StatCard({
  label,
  value,
  hint,
  icon: IconComponent,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: typeof Activity;
  tone: string;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</div>
          {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
        </div>
        <div className={`rounded-lg p-2 ${tone}`}>
          <IconComponent className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const summary = useQuery({
    queryKey: ['runs', 'summary'],
    refetchInterval: 15_000,
    queryFn: async () => (await api.get<Summary>('/runs/stats/summary')).data,
  });

  const recentRuns = useQuery({
    queryKey: ['runs', 'recent'],
    refetchInterval: 10_000,
    queryFn: async () => (await api.get<{ runs: Run[] }>('/runs', { params: { limit: 8 } })).data.runs,
  });

  const workflows = useQuery({
    queryKey: ['workflows', 'recent'],
    queryFn: async () => (await api.get<{ workflows: Workflow[] }>('/workflows')).data.workflows,
  });

  const stats = summary.data;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A quick look at what your automations have been doing."
        actions={
          <Link to="/workflows" className="btn-primary">
            <Plus className="h-4 w-4" />
            New workflow
          </Link>
        }
      />

      <div className="px-8 py-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Runs (24h)"
            value={stats?.last24h.total ?? 0}
            icon={Activity}
            tone="bg-blue-50 text-blue-600"
          />
          <StatCard
            label="Successful"
            value={stats?.last24h.success ?? 0}
            icon={CheckCircle2}
            tone="bg-emerald-50 text-emerald-600"
          />
          <StatCard
            label="Failed"
            value={stats?.last24h.error ?? 0}
            icon={XCircle}
            tone="bg-rose-50 text-rose-600"
          />
          <StatCard
            label="Active workflows"
            value={`${stats?.activeWorkflows ?? 0} / ${stats?.workflows ?? 0}`}
            hint={
              stats
                ? `${stats.queue.pending} queued · ${stats.queue.active} running`
                : undefined
            }
            icon={Zap}
            tone="bg-amber-50 text-amber-600"
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">Latest runs</h2>
              <Link to="/runs" className="text-xs font-medium text-brand-600 hover:underline">
                View all
              </Link>
            </div>

            <div className="card divide-y divide-slate-100">
              {recentRuns.isLoading ? (
                <div className="flex justify-center p-8">
                  <Spinner className="text-brand-600" />
                </div>
              ) : recentRuns.data && recentRuns.data.length > 0 ? (
                recentRuns.data.map((run) => (
                  <Link
                    key={run._id}
                    to={`/runs/${run._id}`}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50"
                  >
                    <StatusBadge status={run.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">
                        {run.workflowName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {run.mode} · {relativeTime(run.createdAt)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs text-slate-400">
                      {formatDuration(run.durationMs)}
                    </div>
                  </Link>
                ))
              ) : (
                <div className="p-6 text-center text-sm text-slate-500">
                  No runs yet. Build a workflow and hit Test to see it here.
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">Workflows</h2>
              <Link to="/workflows" className="text-xs font-medium text-brand-600 hover:underline">
                Manage
              </Link>
            </div>

            <div className="card divide-y divide-slate-100">
              {workflows.data && workflows.data.length > 0 ? (
                workflows.data.slice(0, 8).map((workflow) => (
                  <Link
                    key={workflow._id}
                    to={`/workflows/${workflow._id}`}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        workflow.active ? 'bg-emerald-500' : 'bg-slate-300'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">
                        {workflow.name}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Clock className="h-3 w-3" />
                        {workflow.stats?.lastRunAt
                          ? relativeTime(workflow.stats.lastRunAt)
                          : 'never run'}
                      </div>
                    </div>
                  </Link>
                ))
              ) : (
                <div className="p-6">
                  <EmptyState
                    title="No workflows yet"
                    description="Create your first automation to replace what Uncanny Automator was doing."
                    action={
                      <Link to="/workflows" className="btn-primary">
                        <Plus className="h-4 w-4" />
                        New workflow
                      </Link>
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
