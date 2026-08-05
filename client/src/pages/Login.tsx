import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';

export default function Login() {
  const { login, setup, needsSetup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (needsSetup) {
        await setup(name, email, password);
        toast.success('Welcome to SVASTHA Automator');
      } else {
        await login(email, password);
      }
    } catch (error) {
      toast.error(errorMessage(error, 'Could not sign in'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/20">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 16l7-11 7 11" />
              <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">SVASTHA Automator</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {needsSetup
              ? 'Create the owner account to get started.'
              : 'Sign in to manage your automations.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6">
          {needsSetup ? (
            <div className="mb-4">
              <label className="label" htmlFor="name">
                Your name
              </label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Sumit"
                required
                autoFocus
              />
            </div>
          ) : null}

          <div className="mb-4">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
              autoFocus={!needsSetup}
            />
          </div>

          <div className="mb-6">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={needsSetup ? 'At least 8 characters' : '••••••••'}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              required
              minLength={8}
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? <Spinner /> : null}
            {needsSetup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">
          Self-hosted automation for your team.
        </p>
      </div>
    </div>
  );
}
