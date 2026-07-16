import { env } from '@/env';

export class ApiError extends Error {
  // Not parameter properties: `erasableSyntaxOnly` is on.
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** class-validator returns `message` as an array; joining it surfaces the real failure. */
function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
  }
  return `Request failed (${status})`;
}

// `object`, not Record<string, unknown> — interfaces lack an index signature.
function buildQuery(params?: object): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // Nest's validation rejects `search=`, so drop empties rather than send them.
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
}

/** Throws ApiError on non-2xx so TanStack Query's error path works. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal } = options;

  const res = await fetch(`${env.apiBaseUrl}/api${path}${buildQuery(query)}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    throw new ApiError(res.status, messageFrom(res.status, parsed), parsed);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
