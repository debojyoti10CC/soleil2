import type { Request, Response } from 'express';
import { z } from 'zod';
import { DomainError } from './domain.js';

const UPSTREAM = 'https://rpc.moderato.tempo.xyz';
const READ_METHODS = new Set(['eth_chainId', 'eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionCount', 'eth_getBalance']);
const WRITE_METHODS = new Set(['tempo_fundAddress', 'eth_sendRawTransaction']);
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(100), z.number().int().safe(), z.null()]), method: z.string().min(1).max(80), params: z.array(z.unknown()).max(16).optional() }).strict();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export function createTestnetRelay(fetcher: typeof fetch = fetch, clock = Date.now) {
  let activeRequests = 0;
  const rate = new Map<string, { until: number; reads: number; writes: number }>();
  return async (req: Request, res: Response) => {
    const input = envelope.parse(req.body), write = WRITE_METHODS.has(input.method);
    if (!write && !READ_METHODS.has(input.method)) throw new DomainError('This RPC method is unavailable through the local testnet relay.', 'RPC_METHOD_DENIED', 403);
    if (write) {
      const remote = req.socket.remoteAddress ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new DomainError('Testnet writes are available only from the local machine.', 'RPC_LOCAL_ONLY', 403);
      // A loopback socket alone is insufficient when a public reverse proxy forwards requests.
      // Require the browser application itself to have a loopback origin for writable testnet access.
      const origin = req.get('origin');
      const hostname = origin ? new URL(origin).hostname : '';
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new DomainError('Testnet writes require a local application origin.', 'RPC_LOCAL_ONLY', 403);
      const params = input.params ?? [];
      if (input.method === 'tempo_fundAddress' && (params.length !== 1 || typeof params[0] !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(params[0]))) throw new DomainError('Provide one testnet recipient address.', 'INVALID_RPC_PARAMS');
      if (input.method === 'eth_sendRawTransaction' && (params.length !== 1 || typeof params[0] !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(params[0]) || params[0].length > 60_000)) throw new DomainError('Provide one bounded signed testnet transaction.', 'INVALID_RPC_PARAMS');
    }
    const currentTime = clock(), address = req.socket.remoteAddress ?? 'unknown';
    let current = rate.get(address);
    if (!current || current.until <= currentTime) { current = { until: currentTime + 60_000, reads: 0, writes: 0 }; rate.set(address, current); }
    if (write ? ++current.writes > 30 : ++current.reads > 240) throw new DomainError('Testnet RPC rate limit reached. Try again shortly.', 'RPC_RATE_LIMITED', 429);
    if (activeRequests >= 8) throw new DomainError('The testnet relay is busy. Retry shortly.', 'RPC_BUSY', 429);
    if (rate.size > 10_000) for (const [key, value] of rate) if (value.until <= currentTime) rate.delete(key);
    activeRequests++;
    try {
      const upstream = await fetcher(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!upstream.ok || !upstream.body) throw new Error('RPC unavailable');
      const reader = upstream.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('RPC response too large'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' || !('id' in payload) || payload.id !== input.id || (!('result' in payload) && !('error' in payload))) throw new Error('Invalid upstream response');
      res.json(payload);
    } catch {
      // No upstream body, stack, private transaction contents or proxy credentials enter application errors/logs.
      res.status(502).json({ jsonrpc: '2.0', id: input.id, error: { code: -32000, message: 'Tempo testnet RPC is unavailable. Retry shortly.' } });
    } finally { activeRequests--; }
  };
}
