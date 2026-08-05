import { create } from 'zustand';
import { api, setToken } from '@/lib/api';
import type { User } from '@/lib/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  needsSetup: false,

  async bootstrap() {
    try {
      const { data } = await api.get<{ needsSetup: boolean }>('/auth/status');
      set({ needsSetup: data.needsSetup });
      if (data.needsSetup) {
        set({ user: null, loading: false });
        return;
      }
      const me = await api.get<{ user: User }>('/auth/me');
      set({ user: me.data.user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  async login(email, password) {
    const { data } = await api.post<{ token: string; user: User }>('/auth/login', {
      email,
      password,
    });
    setToken(data.token);
    set({ user: data.user, needsSetup: false });
  },

  async setup(name, email, password) {
    const { data } = await api.post<{ token: string; user: User }>('/auth/setup', {
      name,
      email,
      password,
    });
    setToken(data.token);
    set({ user: data.user, needsSetup: false });
  },

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      setToken(null);
      set({ user: null });
    }
  },
}));
