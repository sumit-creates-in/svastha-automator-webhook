import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Activity,
  LayoutDashboard,
  LogOut,
  Plug,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/store/auth';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon },
  { to: '/runs', label: 'Run history', icon: Activity },
  { to: '/connections', label: 'Connections', icon: Plug },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 16l7-11 7 11" />
              <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-slate-900">SVASTHA</div>
            <div className="text-xs font-medium text-slate-500">Automator</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
              {user?.name?.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">{user?.name}</div>
              <div className="truncate text-xs capitalize text-slate-500">{user?.role}</div>
            </div>
            <button
              onClick={handleLogout}
              className="btn-ghost p-1.5"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
