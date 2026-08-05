import { clsx, type ClassValue } from 'clsx';
import { formatDistanceToNowStrict } from 'date-fns';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function relativeTime(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDistanceToNowStrict(date)} ago`;
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function uid(prefix = 'n'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

/** Ensures a new node gets a name that is unique within the workflow. */
export function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let counter = 1;
  let candidate = `${base} ${counter}`;
  while (existing.includes(candidate)) {
    counter += 1;
    candidate = `${base} ${counter}`;
  }
  return candidate;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const STATUS_STYLES: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  error: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  running: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  queued: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
  waiting: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',
  skipped: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',
  stopped: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};
