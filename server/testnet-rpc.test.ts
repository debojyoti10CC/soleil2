import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';

describe('bounded fixed-upstream testnet relay', () => {
  let server: Server | undefined, service: ReturnType<typeof createApp> | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve())); service?.close(); server = undefined; service = undefined; });
  async function setup(fetcher: typeof fetch, demoEnabled = true, appOrigin = 'http://localhost:5173') {
    service = createApp({ databasePath: ':memory:', demoEnabled, appOrigin, rpcFetch: fetcher }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server!.once('listening', r)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (body: unknown, origin = 'http://localhost:5173') => fetch(base + '/api/testnet/rpc', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('passes allowed reads unchanged without a session and never accepts a caller URL', async () => {
    const mock = vi.fn<typeof fetch>(async (_url, options) => { const input = JSON.parse(options!.body as string); return Response.json({ jsonrpc: '2.0', id: input.id, result: '0xa5bf' }); }); const rpc = await setup(mock);
    const result = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }); expect(await result.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0xa5bf' }); expect(mock.mock.calls[0]![0]).toBe('https://rpc.moderato.tempo.xyz');
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'eth_chainId', url: 'http://private-service' })).status).toBe(400);
  });
  it('denies arbitrary methods, batches, foreign origins and malformed write parameters before upstream', async () => {
    const mock = vi.fn<typeof fetch>(); const rpc = await setup(mock);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'admin_peers', params: [] })).status).toBe(403);
    expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }])).status).toBe(400);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, 'https://attacker.example')).status).toBe(403);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: ['bad-address'] })).status).toBe(400);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x1'] })).status).toBe(400); expect(mock).not.toHaveBeenCalled();
  });
  it('permits local same-origin faucet requests and signed testnet transactions only', async () => {
    const mock = vi.fn<typeof fetch>(async (_url, options) => { const input = JSON.parse(options!.body as string); return Response.json({ jsonrpc: '2.0', id: input.id, result: '0xtest' }); }); const rpc = await setup(mock);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: ['0x' + '1'.repeat(40)] })).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['0x1234'] })).status).toBe(200);
  });
  it('does not treat a public reverse-proxy origin as a local writer', async () => {
    const mock = vi.fn<typeof fetch>(async (_url, options) => { const input = JSON.parse(options!.body as string); return Response.json({ jsonrpc: '2.0', id: input.id, result: '0xa5bf' }); }); const rpc = await setup(mock, true, 'https://public.example');
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, 'https://public.example')).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tempo_fundAddress', params: ['0x' + '1'.repeat(40)] }, 'https://public.example')).status).toBe(403);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('disables the relay without explicit demo configuration and sanitizes upstream failures', async () => {
    const mock = vi.fn<typeof fetch>(async () => { throw new Error('secret proxy credentials'); }); const rpc = await setup(mock, false); expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).status).toBe(403); expect(mock).not.toHaveBeenCalled();
  });
  it('returns bounded JSON-RPC errors for upstream failures or invalid envelopes', async () => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ error: 'secret upstream message' })); const rpc = await setup(mock);
    const response = await rpc({ jsonrpc: '2.0', id: 42, method: 'eth_chainId' }); expect(response.status).toBe(502); const body = await response.json(); expect(body.id).toBe(42); expect(body.error.message).toContain('unavailable'); expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('caps repeated signed writes before calling upstream', async () => {
    const mock = vi.fn<typeof fetch>(async (_url, options) => { const input = JSON.parse(options!.body as string); return Response.json({ jsonrpc: '2.0', id: input.id, result: '0xtest' }); }); const rpc = await setup(mock);
    for (let n = 0; n < 30; n++) expect((await rpc({ jsonrpc: '2.0', id: n, method: 'eth_sendRawTransaction', params: ['0x1234'] })).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 31, method: 'eth_sendRawTransaction', params: ['0x1234'] })).status).toBe(429); expect(mock).toHaveBeenCalledTimes(30);
  });
});
