import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Download, MoreVertical, Plus, Search, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-react';
import Icon from '@/components/Icon';
import PageHeader from '@/components/PageHeader';
import { EmptyState, Modal, Spinner, Toggle } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Workflow } from '@/lib/types';
import { relativeTime, uid } from '@/lib/utils';
import { toast } from 'sonner';

export default function Workflows() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const workflows = useQuery({
    queryKey: ['workflows', search],
    queryFn: async () =>
      (await api.get<{ workflows: Workflow[] }>('/workflows', { params: { search } })).data
        .workflows,
  });

  const templates = useQuery({
    queryKey: ['templates'],
    staleTime: Infinity,
    queryFn: async () =>
      (
        await api.get<{
          templates: Array<{
            id: string;
            name: string;
            description: string;
            requires: string[];
            icon: string;
            stepCount: number;
          }>;
        }>('/workflows/meta/templates')
      ).data.templates,
  });

  const fromTemplate = useMutation({
    mutationFn: async (templateId: string) => {
      const { data } = await api.post<{ workflow: Workflow }>(
        `/workflows/from-template/${templateId}`,
        newName.trim() ? { name: newName.trim() } : {},
      );
      return data.workflow;
    },
    onSuccess: (workflow) => {
      setCreating(false);
      setNewName('');
      navigate(`/workflows/${workflow._id}`);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not create from that template')),
  });

  const create = useMutation({
    mutationFn: async (name: string) => {
      const triggerId = uid('node');
      const { data } = await api.post<{ workflow: Workflow }>('/workflows', {
        name,
        description: '',
        nodes: [
          {
            id: triggerId,
            type: 'webhookTrigger',
            name: 'Webhook',
            position: { x: 120, y: 200 },
            params: {
              httpMethod: 'POST',
              authentication: 'none',
              responseMode: 'immediately',
            },
          },
        ],
        edges: [],
      });
      return data.workflow;
    },
    onSuccess: (workflow) => {
      setCreating(false);
      setNewName('');
      navigate(`/workflows/${workflow._id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      (await api.patch<{ workflow: Workflow }>(`/workflows/${id}/active`, { active })).data.workflow,
    onSuccess: (workflow) => {
      toast.success(workflow.active ? 'Workflow activated' : 'Workflow paused');
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change the status')),
  });

  const duplicate = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ workflow: Workflow }>(`/workflows/${id}/duplicate`)).data.workflow,
    onSuccess: () => {
      toast.success('Copy created');
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/workflows/${id}`),
    onSuccess: () => {
      toast.success('Workflow deleted');
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  const handleExport = async (workflow: Workflow) => {
    const { data } = await api.get(`/workflows/${workflow._id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${workflow.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const { data } = await api.post<{ workflow: Workflow }>('/workflows/import', payload);
      toast.success('Workflow imported');
      navigate(`/workflows/${data.workflow._id}`);
    } catch (error) {
      toast.error(errorMessage(error, 'That file could not be imported'));
    }
  };

  return (
    <div onClick={() => setMenuFor(null)}>
      <PageHeader
        title="Workflows"
        description="Each workflow is a trigger plus the steps that follow it."
        actions={
          <>
            <label className="btn-secondary cursor-pointer">
              <Upload className="h-4 w-4" />
              Import
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleImport(file);
                  event.target.value = '';
                }}
              />
            </label>
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New workflow
            </button>
          </>
        }
      />

      <div className="px-8 py-6">
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search workflows"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {workflows.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="text-brand-600" />
          </div>
        ) : workflows.data && workflows.data.length > 0 ? (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Steps</th>
                  <th className="px-4 py-3 font-semibold">Runs</th>
                  <th className="px-4 py-3 font-semibold">Last run</th>
                  <th className="px-4 py-3 font-semibold">Active</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {workflows.data.map((workflow) => (
                  <tr key={workflow._id} className="group hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/workflows/${workflow._id}`}
                        className="font-medium text-slate-800 hover:text-brand-700"
                      >
                        {workflow.name}
                      </Link>
                      {workflow.description ? (
                        <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                          {workflow.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{workflow.nodes?.length ?? 0}</td>
                    <td className="px-4 py-3 text-slate-600">
                      <span className="text-emerald-600">{workflow.stats?.success ?? 0}</span>
                      {' / '}
                      <span className="text-rose-600">{workflow.stats?.errors ?? 0}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {workflow.stats?.lastRunAt ? relativeTime(workflow.stats.lastRunAt) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Toggle
                        checked={workflow.active}
                        onChange={(active) => toggleActive.mutate({ id: workflow._id, active })}
                      />
                    </td>
                    <td className="relative px-4 py-3">
                      <button
                        className="btn-ghost p-1.5"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuFor(menuFor === workflow._id ? null : workflow._id);
                        }}
                        aria-label="More actions"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {menuFor === workflow._id ? (
                        <div
                          className="absolute right-4 top-11 z-20 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-panel"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onClick={() => {
                              duplicate.mutate(workflow._id);
                              setMenuFor(null);
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" /> Duplicate
                          </button>
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onClick={() => {
                              void handleExport(workflow);
                              setMenuFor(null);
                            }}
                          >
                            <Download className="h-3.5 w-3.5" /> Export JSON
                          </button>
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete "${workflow.name}"? Its run history will be removed too.`,
                                )
                              ) {
                                remove.mutate(workflow._id);
                              }
                              setMenuFor(null);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<WorkflowIcon className="h-10 w-10" />}
            title="No workflows yet"
            description="A workflow starts with a trigger — a webhook, a schedule, or a manual run — and then does whatever you connect to it."
            action={
              <button className="btn-primary" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Create your first workflow
              </button>
            }
          />
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New workflow"
        description="Start from scratch, or from a working example you can edit."
        wide
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={!newName.trim() || create.isPending}
              onClick={() => create.mutate(newName.trim())}
            >
              {create.isPending ? <Spinner /> : null}
              Create blank workflow
            </button>
          </>
        }
      >
        <label className="label" htmlFor="wf-name">
          Workflow name
        </label>
        <input
          id="wf-name"
          className="input"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Contact form to email"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter' && newName.trim()) create.mutate(newName.trim());
          }}
        />

        <div className="mt-6">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Or start from a template
          </h3>
          <p className="mb-3 text-xs text-slate-500">
            Each one is a complete, editable workflow — fill in your connections and go.
          </p>

          <div className="space-y-2">
            {(templates.data ?? []).map((template) => (
              <button
                key={template.id}
                className="flex w-full items-start gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-60"
                disabled={fromTemplate.isPending}
                onClick={() => fromTemplate.mutate(template.id)}
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                  <Icon name={template.icon} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800">{template.name}</div>
                  <div className="mt-0.5 text-xs leading-snug text-slate-500">
                    {template.description}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <span className="badge bg-slate-100 text-[10px] text-slate-600">
                      {template.stepCount} steps
                    </span>
                    {template.requires.map((requirement) => (
                      <span
                        key={requirement}
                        className="badge bg-amber-50 text-[10px] text-amber-700 ring-1 ring-amber-200"
                      >
                        needs {requirement.toLowerCase()}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
