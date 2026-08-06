import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LogIn, Plug, Plus, TestTube2, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import Icon from '@/components/Icon';
import PropertyRenderer from '@/components/editor/PropertyRenderer';
import PageHeader from '@/components/PageHeader';
import { EmptyState, Modal, Spinner } from '@/components/ui';
import { useCatalogue } from '@/hooks/useCatalogue';
import { api, errorMessage } from '@/lib/api';
import type { Connection, ConnectionTypeDefinition } from '@/lib/types';
import { relativeTime } from '@/lib/utils';

export default function Connections() {
  const queryClient = useQueryClient();
  const catalogue = useCatalogue();

  const [editing, setEditing] = useState<{
    id?: string;
    type: ConnectionTypeDefinition;
    name: string;
    config: Record<string, unknown>;
  } | null>(null);
  const [picking, setPicking] = useState(false);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: async () =>
      (await api.get<{ connections: Connection[] }>('/connections')).data.connections,
  });

  const startCreate = (type: ConnectionTypeDefinition) => {
    const config: Record<string, unknown> = {};
    for (const property of type.properties) {
      if (property.default !== undefined) config[property.name] = property.default;
    }
    setPicking(false);
    setEditing({ type, name: '', config });
  };

  const startEdit = async (connection: Connection) => {
    const definition = catalogue.data?.connections.find((item) => item.type === connection.type);
    if (!definition) return;
    const { data } = await api.get<{ config: Record<string, unknown> }>(
      `/connections/${connection._id}/config`,
    );
    setEditing({ id: connection._id, type: definition, name: connection.name, config: data.config });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      if (editing.id) {
        await api.put(`/connections/${editing.id}`, {
          name: editing.name,
          config: editing.config,
        });
      } else {
        await api.post('/connections', {
          name: editing.name,
          type: editing.type.type,
          config: editing.config,
        });
      }
    },
    onSuccess: () => {
      toast.success('Connection saved');
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not save the connection')),
  });

  /**
   * Opens Google's consent screen in a popup. The callback page closes itself,
   * so we just poll for that and refresh once it's gone.
   */
  const connectGoogle = useMutation({
    mutationFn: async (connectionId: string) => {
      const { data } = await api.post<{ url: string }>(
        `/connections/${connectionId}/oauth/google/start`,
      );
      return data.url;
    },
    onSuccess: (url) => {
      const popup = window.open(url, 'svastha-google', 'width=520,height=680');
      if (!popup) {
        toast.error('Allow pop-ups for this site, then try again.');
        return;
      }
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          void queryClient.invalidateQueries({ queryKey: ['connections'] });
          toast.success('Checked with Google — test the connection to confirm.');
        }
      }, 700);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start the Google flow')),
  });

  const test = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ ok: boolean; error?: string }>(`/connections/${id}/test`)).data,
    onSuccess: (result) => {
      if (result.ok) toast.success('Connection works');
      else toast.error(result.error ?? 'The test failed');
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/connections/${id}`),
    onSuccess: () => {
      toast.success('Connection deleted');
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Credentials your steps reuse. Passwords and API keys are encrypted before they are stored."
        actions={
          <button className="btn-primary" onClick={() => setPicking(true)}>
            <Plus className="h-4 w-4" />
            New connection
          </button>
        }
      />

      <div className="px-8 py-6">
        {connections.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="text-brand-600" />
          </div>
        ) : connections.data && connections.data.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {connections.data.map((connection) => {
              const definition = catalogue.data?.connections.find(
                (item) => item.type === connection.type,
              );
              return (
                <div key={connection._id} className="card p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                      <Icon name={definition?.icon ?? 'KeyRound'} className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {connection.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        {definition?.displayName ?? connection.type}
                      </div>
                    </div>
                    {connection.lastTestedAt ? (
                      connection.lastTestOk ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                      )
                    ) : null}
                  </div>

                  {Object.keys(connection.preview ?? {}).length > 0 ? (
                    <dl className="mt-3 space-y-1 rounded-lg bg-slate-50 p-2.5 text-xs">
                      {Object.entries(connection.preview).map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-3">
                          <dt className="text-slate-500">{key}</dt>
                          <dd className="truncate font-mono text-slate-700">{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {connection.lastTestedAt ? (
                    <p className="mt-2 text-[11px] text-slate-400">
                      Tested {relativeTime(connection.lastTestedAt)}
                      {connection.lastTestError ? ` — ${connection.lastTestError}` : ''}
                    </p>
                  ) : null}

                  {connection.type === 'googleOAuth2' ? (
                    <button
                      className="btn-secondary btn-sm mt-3 w-full justify-center"
                      onClick={() => connectGoogle.mutate(connection._id)}
                      disabled={connectGoogle.isPending}
                    >
                      {connectGoogle.isPending ? <Spinner /> : <LogIn className="h-3.5 w-3.5" />}
                      {connection.preview?.scope ? 'Reconnect with Google' : 'Connect with Google'}
                    </button>
                  ) : null}

                  {connection.type === 'googleServiceAccount' && connection.preview?.clientEmail ? (
                    <p className="mt-3 rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200">
                      Share each spreadsheet with{' '}
                      <strong className="break-all">{String(connection.preview.clientEmail)}</strong>{' '}
                      as an Editor, or Google will refuse.
                    </p>
                  ) : null}

                  <div className="mt-3 flex gap-2">
                    <button
                      className="btn-secondary btn-sm flex-1"
                      onClick={() => void startEdit(connection)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => test.mutate(connection._id)}
                      disabled={test.isPending}
                      title="Test connection"
                    >
                      <TestTube2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="btn-ghost btn-sm text-slate-400 hover:text-rose-600"
                      onClick={() => {
                        if (confirm(`Delete "${connection.name}"? Steps using it will fail.`)) {
                          remove.mutate(connection._id);
                        }
                      }}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Plug className="h-10 w-10" />}
            title="No connections yet"
            description="Add your SMTP details once, then every email step can use them."
            action={
              <button className="btn-primary" onClick={() => setPicking(true)}>
                <Plus className="h-4 w-4" />
                Add a connection
              </button>
            }
          />
        )}
      </div>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a connection type"
        description="Pick what you want to connect to."
      >
        <div className="space-y-2">
          {(catalogue.data?.connections ?? []).map((definition) => (
            <button
              key={definition.type}
              className="flex w-full items-start gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-brand-300 hover:bg-brand-50/40"
              onClick={() => startCreate(definition)}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <Icon name={definition.icon} className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-800">{definition.displayName}</div>
                <div className="mt-0.5 text-xs text-slate-500">{definition.description}</div>
              </div>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit connection' : `New ${editing?.type.displayName ?? ''} connection`}
        description={editing?.type.description}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => save.mutate()}
              disabled={!editing?.name.trim() || save.isPending}
            >
              {save.isPending ? <Spinner /> : null}
              Save
            </button>
          </>
        }
      >
        {editing ? (
          <>
            <div className="mb-4">
              <label className="label">Connection name</label>
              <input
                className="input"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                placeholder="Hostinger mailbox"
                autoFocus
              />
            </div>

            <PropertyRenderer
              properties={editing.type.properties}
              values={editing.config}
              onChange={(propertyName, value) =>
                setEditing({
                  ...editing,
                  config: { ...editing.config, [propertyName]: value },
                })
              }
            />

            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
              Secrets are encrypted with AES-256-GCM before being written to the database and are
              never sent back to the browser in full.
            </p>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
