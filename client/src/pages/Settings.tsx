import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import PageHeader from '@/components/PageHeader';
import { Field, Modal, Spinner, Toggle } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { User } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import { useAuth } from '@/store/auth';

export default function Settings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'admin';

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({
    name: '',
    email: '',
    password: '',
    role: 'member' as User['role'],
  });

  const users = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get<{ users: User[] }>('/users')).data.users,
  });

  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get('/health')).data as Record<string, unknown>,
  });

  const changePassword = useMutation({
    mutationFn: async () => api.patch('/auth/password', { currentPassword, newPassword }),
    onSuccess: () => {
      toast.success('Password updated');
      setCurrentPassword('');
      setNewPassword('');
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not update the password')),
  });

  const createUser = useMutation({
    mutationFn: async () => api.post('/users', invite),
    onSuccess: () => {
      toast.success('User added');
      setInviting(false);
      setInvite({ name: '', email: '', password: '', role: 'member' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not add the user')),
  });

  const updateUser = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<User> }) =>
      api.patch(`/users/${id}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      toast.success('User removed');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div>
      <PageHeader title="Settings" description="Your account, your team, and system status." />

      <div className="max-w-4xl space-y-8 px-8 py-6">
        <section className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-800">Change your password</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password">
              <input
                type="password"
                className="input"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input
                type="password"
                className="input"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <button
            className="btn-primary"
            disabled={!currentPassword || newPassword.length < 8 || changePassword.isPending}
            onClick={() => changePassword.mutate()}
          >
            {changePassword.isPending ? <Spinner /> : null}
            Update password
          </button>
        </section>

        <section className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Team</h2>
            {canManage ? (
              <button className="btn-secondary btn-sm" onClick={() => setInviting(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add user
              </button>
            ) : null}
          </div>

          <div className="divide-y divide-slate-100">
            {(users.data ?? []).map((item) => (
              <div key={item._id} className="flex items-center gap-3 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                  {item.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{item.name}</div>
                  <div className="truncate text-xs text-slate-500">{item.email}</div>
                </div>
                <div className="hidden text-xs text-slate-400 sm:block">
                  {item.lastLoginAt ? `seen ${relativeTime(item.lastLoginAt)}` : 'never signed in'}
                </div>
                {canManage && item.role !== 'owner' ? (
                  <select
                    className="input w-auto py-1 text-xs"
                    value={item.role}
                    onChange={(event) =>
                      updateUser.mutate({
                        id: item._id,
                        patch: { role: event.target.value as User['role'] },
                      })
                    }
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </select>
                ) : (
                  <span className="badge bg-slate-100 capitalize text-slate-600">{item.role}</span>
                )}
                {canManage && item.role !== 'owner' ? (
                  <>
                    <Toggle
                      checked={item.active}
                      onChange={(active) => updateUser.mutate({ id: item._id, patch: { active } })}
                    />
                    {user?.role === 'owner' ? (
                      <button
                        className="btn-ghost p-1.5 text-slate-400 hover:text-rose-600"
                        onClick={() => {
                          if (confirm(`Remove ${item.name}?`)) deleteUser.mutate(item._id);
                        }}
                        aria-label="Remove user"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">System</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            {Object.entries(health.data ?? {}).map(([key, value]) => (
              <div key={key} className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {key}
                </dt>
                <dd className="mt-1 font-mono text-sm text-slate-800">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Add a user"
        description="They can sign in immediately with the password you set here."
        footer={
          <>
            <button className="btn-secondary" onClick={() => setInviting(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={
                !invite.name || !invite.email || invite.password.length < 8 || createUser.isPending
              }
              onClick={() => createUser.mutate()}
            >
              {createUser.isPending ? <Spinner /> : null}
              Add user
            </button>
          </>
        }
      >
        <Field label="Name" required>
          <input
            className="input"
            value={invite.name}
            onChange={(event) => setInvite({ ...invite, name: event.target.value })}
            autoFocus
          />
        </Field>
        <Field label="Email" required>
          <input
            type="email"
            className="input"
            value={invite.email}
            onChange={(event) => setInvite({ ...invite, email: event.target.value })}
          />
        </Field>
        <Field label="Temporary password" hint="At least 8 characters." required>
          <input
            className="input"
            value={invite.password}
            onChange={(event) => setInvite({ ...invite, password: event.target.value })}
          />
        </Field>
        <Field label="Role">
          <select
            className="input"
            value={invite.role}
            onChange={(event) => setInvite({ ...invite, role: event.target.value as User['role'] })}
          >
            <option value="member">Member — build and run workflows</option>
            <option value="admin">Admin — also manages users</option>
          </select>
        </Field>
      </Modal>
    </div>
  );
}
