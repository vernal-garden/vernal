const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, payload?: unknown): Promise<T | undefined> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  if (res.status === 204) return undefined;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text().catch(() => null);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const get  = <T>(path: string)                   => request<T>('GET',    path);
export const post = <T>(path: string, body?: unknown)   => request<T>('POST',   path, body);
export const patch = <T>(path: string, body?: unknown)  => request<T>('PATCH',  path, body);
export const del  = <T>(path: string)                   => request<T>('DELETE', path);
