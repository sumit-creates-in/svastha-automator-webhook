import axios, { type AxiosError } from 'axios';

const TOKEN_KEY = 'svastha.token';

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: string }>) => {
    if (error.response?.status === 401 && !location.pathname.startsWith('/login')) {
      localStorage.removeItem(TOKEN_KEY);
      location.href = '/login';
    }
    return Promise.reject(error);
  },
);

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

interface ApiErrorShape {
  error?: string;
  details?: Array<{ field?: string; message?: string }> | unknown;
}

/** Turns an axios failure into a sentence worth showing a person. */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const axiosError = error as AxiosError<ApiErrorShape>;
  const data = axiosError?.response?.data;
  if (data?.error) {
    if (Array.isArray(data.details) && data.details.length > 0) {
      const first = data.details[0] as { message?: string };
      if (first?.message) return `${data.error}: ${first.message}`;
    }
    return data.error;
  }
  if (axiosError?.message === 'Network Error') return 'Cannot reach the server.';
  return axiosError?.message || fallback;
}
