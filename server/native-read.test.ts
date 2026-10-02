import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { zeroAddress } from 'viem';
import { NativeTempoWorkspace, nativePaymentId, type NativeBundle } from './native-tempo.js';
import type { Invoice, Worker } from '../src/shared/types.js';
const bundle: NativeBundle = { vaultAddress: '0x1111111111111111111111111111111111111111', employerAddress: '0x2222222222222222222222222222222222222222', callerAddress: '0x3333333333333333333333333333333333333333', workerAddress: '0x4444444444444444444444444444444444444444', tokenAddress: '0x20c0000000000000000000000000000000000000', depositHash: `0x${'aa'.repeat(32)}`, deploymentHash: `0x${'bb'.repeat(32)}`, deploymentBlock: '10', preparedAt: new Date(1000).toISOString() };
const worker: Worker = { id: 'worker', name: 'Fixture worker', email: 'fixture@example.test', address: bundle.workerAddress, rail: 'tempo', received: '0', confirmed: true, blocked: false, managedTestWallet: true };
const invoice: Invoice = { id: 'invoice', number: 'FIX-1', workerId: worker.id, description: 'RPC boundary fixture, no real funds', amount: '1000000', dueAt: new Date(1000).toISOString(), rail: 'tempo', status: 'approved', createdAt: new Date(0).toISOString() };
const resources: { adapter: NativeTempoWorkspace; directory: string }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const { adapter, directory } of resources.splice(0)) { adapter.close(); rmSync(directory, { recursive: true, force: true }); } });
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const directory = mkdtempSync(join(tmpdir(), 'soleil-native-read-')), adapter = new NativeTempoWorkspace({ directory }); resources.push({ adapter, directory });
  // Inject only in this test: production still has one fixed Moderato transport, without RPC fallback.
  const reader = Reflect.get(adapter, 'reader'), journal = Reflect.get(adapter, 'journal'); journal.set('bundle:org', bundle);
  vi.spyOn(reader, 'getChainId').mockResolvedValue(42431);
  vi.spyOn(reader, 'getBlock').mockResolvedValue({ number: 100n, timestamp: 10n });
  vi.spyOn(reader, 'getCode').mockResolvedValue(JSON.parse(readFileSync(resolve('public/contracts/SoleilVault.json'), 'utf8')).deployedBytecode);
  vi.spyOn(reader, 'getLogs').mockResolvedValue([]);
  const claims = { value: [worker.address, 1_000_000n, 1n, false] };
  vi.spyOn(reader, 'readContract').mockImplementation(async (request: any) => ({ decimals: 6, token: bundle.tokenAddress, employer: bundle.employerAddress, strategy: zeroAddress, liquidBalance: 1_000_000_000n, committed: 1_000_000n, buffer: 200_000_000n, retired: false, claims: claims.value, balanceOf: 0n }[request.functionName as string]));
  return { adapter, reader, claims };
}
describe('native RPC verification boundary (isolated fixtures, no transactions)', () => {
  it('pins all balances and claim tuples to one observed block', async () => {
    const { adapter, reader } = fixture(), view = await adapter.sync('org', [invoice], [worker]);
    expect(view.native.status).toBe('live'); expect(view.native.blockNumber).toBe('100'); expect(view.invoices[0].paymentId).toBe(nativePaymentId('org', invoice.id));
    const moneyReads = vi.mocked(reader.readContract).mock.calls.map((call: any[]) => call[0]).filter((request: any) => ['liquidBalance', 'committed', 'buffer', 'retired', 'claims', 'balanceOf'].includes(request.functionName));
    expect(moneyReads).toHaveLength(6); expect(moneyReads.every((request: any) => request.blockNumber === 100n)).toBe(true);
  });
  it('keeps the exact last verified block and timestamp during an RPC outage and never calls it live', async () => {
    const { adapter, reader } = fixture(), before = await adapter.sync('org', [invoice], [worker]);
    vi.mocked(reader.getBlock).mockRejectedValue(new Error('offline'));
    const stale = await adapter.sync('org', before.invoices, [worker]);
    expect(stale.native.status).toBe('stale'); expect(stale.native.checkedAt).toBe(before.native.checkedAt); expect(stale.vault.balance).toBe(before.vault.balance); expect(stale.native.blockNumber).toBe('100');
  });
  it('refuses to bless a locally committed invoice whose claim is absent from chain', async () => {
    const { adapter, claims } = fixture(); claims.value = [zeroAddress, 0n, 0n, false];
    await expect(adapter.sync('org', [{ ...invoice, status: 'committed', paymentId: nativePaymentId('org', invoice.id) }], [worker])).rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' });
  });
  it('pauses verification when the immutable chain amount differs from the invoice', async () => {
    const { adapter, claims } = fixture(), before = await adapter.sync('org', [invoice], [worker]); claims.value = [worker.address, 1_000_001n, 1n, false];
    const stale = await adapter.sync('org', before.invoices, [worker]); expect(stale.native.status).toBe('stale'); expect(stale.invoices[0].amount).toBe(invoice.amount);
  });
  it('rejects a responsive RPC that keeps returning an old head instead of renewing freshness', async () => {
    const { adapter } = fixture(), before = await adapter.sync('org', [invoice], [worker]);
    vi.mocked(Date.now).mockReturnValue(131_000);
    const stale = await adapter.sync('org', before.invoices, [worker]);
    expect(stale.native.status).toBe('stale'); expect(stale.native.checkedAt).toBe(before.native.checkedAt); expect(stale.native.warning).toContain('head');
  });
});
