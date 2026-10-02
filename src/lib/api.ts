import type { Session } from '../shared/types';
let currentSession: Session | null = null;
const pendingKeys = new Map<string, { key: string; createdAt: number }>();
function savePending() {
  if (!currentSession || typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(`soleil.pending.${currentSession.user.id}`, JSON.stringify([...pendingKeys])); } catch { /* Chain IDs still protect commit/pay; restricted storage cannot be bypassed. */ }
}
export function setSession(session: Session | null) {
  if (currentSession?.user.id !== session?.user.id) {
    savePending(); pendingKeys.clear();
    if (session && typeof sessionStorage !== 'undefined') {
      try {
        const saved = JSON.parse(sessionStorage.getItem(`soleil.pending.${session.user.id}`) ?? '[]');
        if (Array.isArray(saved)) for (const entry of saved) if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].startsWith(`${session.user.id}:`) && typeof entry[1]?.key === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(entry[1].key) && Number.isFinite(entry[1].createdAt)) pendingKeys.set(entry[0], entry[1]);
      } catch { /* Malformed browser storage is not a trusted source. */ }
    }
  }
  currentSession = session;
}
export function getSession() { return currentSession; }
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && currentSession) headers['x-csrf-token'] = currentSession.csrfToken;
  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  const intent = method !== 'GET' && !url.startsWith('/api/auth/') ? `${currentSession?.user.id ?? 'anonymous'}:${method}:${url}:${JSON.stringify(options.body)}` : null;
  let requestKey: string | undefined;
  if (intent) {
    const pending = pendingKeys.get(intent);
    const key = options.idempotencyKey ?? pending?.key ?? crypto.randomUUID();
    pendingKeys.set(intent, { key, createdAt: Date.now() });
    savePending();
    headers['x-idempotency-key'] = key;
    requestKey = key;
  }
  const response = await fetch(url, { method, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  let payload: any;
  try { payload = response.status === 204 ? undefined : await response.json(); }
  catch { throw new ApiError('The server returned an unreadable response. Please retry the same action.', 502, 'unreadable_response'); }
  if (!response.ok) {
    if (intent && response.status < 500 && pendingKeys.get(intent)?.key === requestKey) pendingKeys.delete(intent);
    savePending();
    throw new ApiError(payload?.error ?? 'Request failed. Please try again.', response.status, payload?.code);
  }
  if (intent && pendingKeys.get(intent)?.key === requestKey) pendingKeys.delete(intent);
  savePending();
  return payload as T;
}
