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

/**
 * Everything up to the response body: URL building, the fetch, and the non-2xx
 * ApiError. Shared by request() and requestBlob().
 *
 * Split out rather than making request<T> polymorphic over response type — that
 * road ends with request<Blob>() silently returning parsed JSON. Two named
 * functions, one shared shell.
 *
 * The error path stays here and stays JSON: Nest's exception filter returns JSON
 * even from the CSV endpoint, so a failed download still produces a real message
 * instead of a Blob containing an error page.
 */
async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
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

  return res;
}

/** Throws ApiError on non-2xx so TanStack Query's error path works. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, options);

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * A binary/text download rather than JSON. Same errors, same query building.
 *
 * Returns the server's filename when it can: the browser hides Content-Disposition
 * from JS cross-origin unless the server sends Access-Control-Expose-Headers (ours
 * does). Dev is same-origin through the Vite proxy, so a missing expose header
 * would ONLY show up in production — hence the caller-side fallback filename.
 */
export async function requestBlob(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename?: string }> {
  const res = await rawRequest(path, options);
  const filename = filenameFrom(res.headers.get('Content-Disposition'));
  return { blob: await res.blob(), filename };
}

/** `attachment; filename="products-2026-07-17.csv"` -> `products-2026-07-17.csv` */
function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  return /filename="?([^"';]+)"?/.exec(header)?.[1]?.trim();
}
