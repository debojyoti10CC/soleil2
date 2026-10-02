import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setSession } from '../src/lib/api';
import type { Session } from '../src/shared/types';
const session = (id: string) => ({ user: { id }, csrfToken: 'test-csrf' } as Session);
beforeEach(() => { setSession(null); setSession(session('alice')); });
afterEach(() => { setSession(null); vi.unstubAllGlobals(); });
describe('financial request retry keys', () => {
  it('restores an uncertain deposit key after a browser session is reloaded', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher); const action = { method: 'POST', body: { amount: '42' } };
    await expect(api('/vaults/a/deposit', action)).rejects.toThrow('response lost');
    setSession(null); setSession(session('alice')); await api('/vaults/a/deposit', action);
    expect(fetcher.mock.calls[0][1].headers['x-idempotency-key']).toBe(fetcher.mock.calls[1][1].headers['x-idempotency-key']);
    expect(JSON.parse(storage.get('soleil.pending.alice')!)).toEqual([]);
  });
  it('retains the same key after a truncated successful response, then clears it after confirmed success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{', { status: 200 })).mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetcher);
    const action = { method: 'POST', body: { amount: '100' } };
    await expect(api('/vaults/a/deposit', action)).rejects.toMatchObject({ code: 'unreadable_response' });
    await api('/vaults/a/deposit', action);
    await api('/vaults/a/deposit', action);
    const keys = fetcher.mock.calls.map(call => call[1].headers['x-idempotency-key']);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
  });
  it('does not reuse a failed action key after the authenticated user changes', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const action = { method: 'POST', body: { amount: '100' } };
    await expect(api('/vaults/a/deposit', action)).rejects.toThrow('connection lost');
    setSession(session('bob'));
    await api('/vaults/a/deposit', action);
    expect(fetcher.mock.calls[0][1].headers['x-idempotency-key']).not.toBe(fetcher.mock.calls[1][1].headers['x-idempotency-key']);
  });
  it('keeps a newer retry key when an older concurrent response succeeds', async () => {
    let completeFirst!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { completeFirst = resolve; })).mockRejectedValueOnce(new Error('connection lost')).mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetcher);
    const action = { method: 'POST', body: { amount: '100' } };
    const first = api('/vaults/a/deposit', { ...action, idempotencyKey: 'first' });
    await expect(api('/vaults/a/deposit', { ...action, idempotencyKey: 'second' })).rejects.toThrow('connection lost');
    completeFirst(new Response('{}', { status: 200 })); await first;
    await api('/vaults/a/deposit', action);
    expect(fetcher.mock.calls[2][1].headers['x-idempotency-key']).toBe('second');
  });
});
