const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export const apiUrl = (path: string) => `${API_BASE}${path}`;

// The server's `{ error }` text when it sent one, so callers can show it.
function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return `API error ${status}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(errorMessage(status, body));
    this.name = 'ApiError';
  }
}

// The server's `{ error }` text for an ApiError that carries one; otherwise
// (network failure, non-JSON body, non-API error) the caller's friendly text.
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const message = (err.body as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

// The server's `{ code }` for an ApiError that carries one.
export function apiErrorCode(err: unknown): string | undefined {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const code = (err.body as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// AuthProvider's hook for a session held at the terms screen mid-visit, which
// only a failed request can reveal.
let termsRequiredHandler: (() => void) | null = null;

export function setTermsRequiredHandler(handler: (() => void) | null): void {
  termsRequiredHandler = handler;
}

// The terms gate's 403 codes: the main Terms after a claim, and the beta terms.
const TERMS_GATE_CODES = new Set(['terms_required', 'beta_terms_required']);

async function request<T>(method: string, path: string, payload?: unknown): Promise<T | undefined> {
  return send<T>(method, path, {
    headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

async function send<T>(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit },
): Promise<T | undefined> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: init.headers,
    body: init.body,
  });

  if (res.status === 204) return undefined;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text().catch(() => null);
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    // Only the terms gate's 403: the register and accept routes use the same codes on a 400.
    if (res.status === 403 && TERMS_GATE_CODES.has(apiErrorCode(err) ?? '')) termsRequiredHandler?.();
    throw err;
  }
  return data as T;
}

export const get  = <T>(path: string)                   => request<T>('GET',    path);
export const post = <T>(path: string, body?: unknown)   => request<T>('POST',   path, body);
export const patch = <T>(path: string, body?: unknown)  => request<T>('PATCH',  path, body);
export const put  = <T>(path: string, body?: unknown)   => request<T>('PUT',    path, body);
export const del  = <T>(path: string)                   => request<T>('DELETE', path);
// Posts a raw Blob body (e.g. an image) with its own Content-Type, no JSON encoding.
export const postBlob = <T>(path: string, blob: Blob, headers?: Record<string, string>) =>
  send<T>('POST', path, { headers: { 'Content-Type': blob.type, ...headers }, body: blob });
