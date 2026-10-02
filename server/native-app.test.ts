import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Invoice, Session, Snapshot, Worker } from '../src/shared/types.js';
import { createApp } from './app.js';
import { DomainError, type PresentationBundle } from './domain.js';
import { nativePaymentId, type NativeTxResult, type NativeView, type NativeWorkspaceAdapter } from './native-workspace.js';

const time = Date.parse('2026-01-01T00:00:00Z'), origin = 'http://localhost:5173';
interface Client { cookie?: string; csrf?: string; session?: Session; }
class TestAdapter implements NativeWorkspaceAdapter {
  readonly bundles = new Map<string, PresentationBundle>();
  readonly accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>();
  readonly claims = new Map<string, Invoice>();
  readonly received = new Map<string, bigint>();
  readonly balances = new Map<string, bigint>();
  readonly completed = new Map<string, NativeTxResult>();
  readonly retired = new Set<string>();
  readonly pending = new Map<string, string>();
  outage = false; pendingCommit = false; rejectCommit = false; invalidProof = false;
  provisionCalls = 0; commitBroadcasts = 0; payBroadcasts = 0; depositBroadcasts = 0;
  syncBarrier?: () => Promise<void>;
  block = 100n; private hashSequence = 0;
  account(org: string, id: string) { const key = `${org}:${id}`; let value = this.accounts.get(key); if (!value) { value = privateKeyToAccount(generatePrivateKey()); this.accounts.set(key, value); } return value; }
  prepared(org: string) {
    let bundle = this.bundles.get(org);
    if (!bundle) {
      bundle = { vaultAddress: this.account(org, 'vault').address, employerAddress: this.account(org, 'employer').address, callerAddress: this.account(org, 'caller').address, workerAddress: this.account(org, 'presentation_worker').address, tokenAddress: '0x20c0000000000000000000000000000000000000', depositHash: `0x${'a'.repeat(64)}`, preparedAt: new Date(time).toISOString() };
      this.bundles.set(org, bundle); this.balances.set(org, 20_000_000_000n);
    }
    return bundle;
  }
  async provision(org: string) { this.provisionCalls++; return this.prepared(org); }
  cachedBundle(org: string) { return this.bundles.get(org) ?? null; }
  async managedWorker(org: string, id: string) { return this.account(org, id).address; }
  async confirmManagedWorker(org: string, worker: Worker) {
    const account = this.account(org, worker.id), message = `Generated server-controlled test wallet ${org}/${worker.id}`;
    return { address: account.address, message, signature: await (this.invalidProof ? this.account(org, 'wrong-key') : account).signMessage({ message }) };
  }
  result() { this.block++; return { hash: `0x${(++this.hashSequence).toString(16).padStart(64, '0')}`, blockNumber: this.block.toString() }; }
  async commit(org: string, invoice: Invoice, _worker: Worker) {
    const key = `${org}:${invoice.id}`, saved = this.completed.get(`commit:${key}`);
    if (saved) return saved;
    if (this.rejectCommit) throw new DomainError('Native transaction estimation rejected.', 'NATIVE_REJECTED', 409);
    const result = this.result(); this.commitBroadcasts++;
    this.completed.set(`commit:${key}`, result);
    if (this.pendingCommit) { this.pending.set(key, result.hash); throw new DomainError(`Confirmation pending: ${result.hash}`, 'NATIVE_PENDING', 503); }
    this.claims.set(key, { ...invoice, status: 'committed', transactionRef: result.hash, commitTransactionRef: result.hash }); return result;
  }
  reconcile(org: string, invoice: Invoice) {
    const key = `${org}:${invoice.id}`, hash = this.pending.get(key);
    if (hash) { this.claims.set(key, { ...invoice, status: 'committed', transactionRef: hash, commitTransactionRef: hash }); this.pending.delete(key); }
  }
  async pay(org: string, invoices: Invoice[]) {
    const operation = `pay:${org}:${invoices.map(i => i.id).sort().join(':')}`, saved = this.completed.get(operation);
    if (saved) return saved;
    const result = this.result(); this.payBroadcasts++;
    for (const invoice of invoices) {
      const claim = this.claims.get(`${org}:${invoice.id}`)!;
      this.claims.set(`${org}:${invoice.id}`, { ...claim, status: 'paid', transactionRef: result.hash, paidAt: new Date(time).toISOString() });
      this.balances.set(org, this.balances.get(org)! - BigInt(invoice.amount));
      this.received.set(`${org}:${invoice.workerId}`, (this.received.get(`${org}:${invoice.workerId}`) ?? 0n) + BigInt(invoice.amount));
    }
    this.completed.set(operation, result); return result;
  }
  async deposit(org: string, amount: string, key: string) { const operation = `deposit:${org}:${key}`, saved = this.completed.get(operation); if (saved) return saved; const result = this.result(); this.depositBroadcasts++; this.balances.set(org, this.balances.get(org)! + BigInt(amount)); this.completed.set(operation, result); return result; }
  async withdraw(org: string, amount: string, key: string) { const operation = `withdraw:${org}:${key}`, saved = this.completed.get(operation); if (saved) return saved; const result = this.result(); this.balances.set(org, this.balances.get(org)! - BigInt(amount)); this.completed.set(operation, result); return result; }
  async retire(org: string) { this.retired.add(org); return this.result(); }
  async sync(org: string, invoices: Invoice[], workers: Worker[]): Promise<NativeView> {
    await this.syncBarrier?.(); if (this.outage) throw new Error('RPC unavailable');
    const bundle = this.prepared(org), committed = [...this.claims.entries()].filter(([key, invoice]) => key.startsWith(`${org}:`) && invoice.status === 'committed').reduce((n, [, invoice]) => n + BigInt(invoice.amount), 0n), balance = this.balances.get(org)!, buffer = this.retired.has(org) ? 0n : 200_000_000n;
    return {
      vault: { id: 'native_tempo', rail: 'tempo', asset: 'pathUSD', decimals: 6, address: bundle.vaultAddress, balance: balance.toString(), committed: committed.toString(), buffer: buffer.toString(), surplus: (balance > committed + buffer ? balance - committed - buffer : 0n).toString(), strategyPrincipal: '0', strategyValue: '0', riskMode: 'normal', retired: this.retired.has(org), settlementAvailable: balance >= committed },
      invoices: invoices.map(invoice => { const key = `${org}:${invoice.id}`, value = { ...(this.claims.get(key) ?? invoice) }; value.nativePending = this.pending.has(key) ? { operation: 'commit', hash: this.pending.get(key), status: 'submitted' } : undefined; return value; }),
      workers: workers.map(worker => ({ ...worker, received: (this.received.get(`${org}:${worker.id}`) ?? 0n).toString() })),
      native: { network: 'Tempo Moderato', chainId: 42431, status: 'live', checkedAt: new Date(time).toISOString(), blockNumber: this.block.toString(), executor: 'managed-test-wallet', employerAddress: bundle.employerAddress, callerAddress: bundle.callerAddress }, now: new Date(time).toISOString(),
    };
  }
}

describe('native workspace API with an isolated chain adapter', () => {
  let adapter: TestAdapter, service: ReturnType<typeof createApp>, server: Server, base: string, directory: string;
  async function start() { service = createApp({ databasePath: join(directory, 'test.sqlite'), native: adapter, demoEnabled: true, clock: () => time }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
  async function stop() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  beforeEach(async () => { adapter = new TestAdapter(); adapter.prepared('presentation_tempo'); directory = mkdtempSync(join(tmpdir(), 'soleil-native-api-')); await start(); });
  afterEach(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  async function request(client: Client, path: string, body?: unknown, key?: string, customOrigin = origin, csrf?: string) {
    const headers: Record<string, string> = { origin: customOrigin };
    if (client.cookie) headers.cookie = client.cookie; if (client.csrf) headers['x-csrf-token'] = csrf ?? client.csrf; if (key) headers['x-idempotency-key'] = key; if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0];
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    if (data?.csrfToken) { client.csrf = data.csrfToken; client.session = data; } return { response, data };
  }
  async function login(role: 'owner' | 'worker'): Promise<Client> { const client: Client = {}; expect((await request(client, '/api/auth/presentation', { role })).response.status).toBe(200); return client; }
  async function bootstrap(client: Client): Promise<Snapshot> { const result = await request(client, '/api/bootstrap'); expect(result.response.status).toBe(200); return result.data; }
  async function readyCommit() { const employer = await login('owner'), worker = await login('worker'); expect((await request(worker, '/api/workers/presentation_worker/confirm', {}, 'confirm')).response.status).toBe(200); expect((await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'commit')).response.status).toBe(200); return { employer, worker }; }

  it('uses cached presentation sign-in, actual native metadata and no pretend seeded payment', async () => {
    const employer = await login('owner'), state = await bootstrap(employer);
    expect(adapter.provisionCalls).toBe(0); expect((await request({}, '/api/config')).data).toMatchObject({ presentationEnabled: true, presentationReady: true });
    expect((await request({}, '/api/health')).data.mode).toBe('native-testnet'); expect(state.mode).toBe('testnet'); expect(state.native?.status).toBe('live'); expect(state.vaults).toHaveLength(1); expect(state.vaults[0]!.address).toBe(adapter.cachedBundle('presentation_tempo')!.vaultAddress);
    expect(state.invoices[0]).toMatchObject({ status: 'approved', amount: '300000000' }); expect(state.invoices[0]!.paymentId).toBeUndefined(); expect(JSON.stringify(state)).not.toContain('sim_');
    adapter.bundles.delete('presentation_tempo'); expect((await request({}, '/api/auth/presentation', { role: 'owner' })).data.code).toBe('PRESENTATION_NOT_READY'); expect(adapter.provisionCalls).toBe(0);
  });
  it('requires matching worker consent and a valid generated test-key signature before committing', async () => {
    const employer = await login('owner'), worker = await login('worker');
    expect((await request(employer, '/api/workers/presentation_worker/confirm', {}, 'owner-confirm')).response.status).toBe(403);
    expect((await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'unconfirmed')).data.code).toBe('RECIPIENT_UNCONFIRMED');
    adapter.invalidProof = true; expect((await request(worker, '/api/workers/presentation_worker/confirm', {}, 'bad-proof')).data.code).toBe('INVALID_ACCOUNT_PROOF'); expect((await bootstrap(worker)).workers[0]!.confirmed).toBe(false);
    adapter.invalidProof = false; const confirmed = await request(worker, '/api/workers/presentation_worker/confirm', {}, 'valid-proof'); expect(confirmed.response.status).toBe(200); expect(confirmed.data.workers[0].confirmationProof).toContain('server-controlled-generated-test-wallet');
    const committed = await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'unconfirmed'); expect(committed.response.status).toBe(200); expect(committed.data.invoices[0].paymentId).toBe(nativePaymentId('presentation_tempo', 'presentation_invoice')); expect(adapter.commitBroadcasts).toBe(1);
  });
  it('allows the worker to independently pay and exports the real settlement hash instead of the commit hash', async () => {
    const { worker } = await readyCommit(); const before = await bootstrap(worker), commitHash = before.invoices[0]!.transactionRef;
    const paid = await request(worker, '/api/invoices/presentation_invoice/pay', {}, 'worker-pay'); expect(paid.response.status).toBe(200); expect(paid.data.invoices[0].status).toBe('paid'); expect(paid.data.workers[0].received).toBe('300000000');
    const exported = await request(worker, '/api/receipts/presentation_invoice'); expect(exported.data).toMatchObject({ mode: 'testnet', status: 'paid', chainId: 42431, amount: '300000000', commitTransactionRef: commitHash }); expect(exported.data.transactionRef).not.toBe(commitHash); expect(exported.data.explorerUrl).toContain(exported.data.transactionRef); expect(exported.data.statement).toContain('server-controlled');
    expect((await request(worker, '/api/invoices/presentation_invoice/pay', {}, 'worker-pay')).response.status).toBe(200); expect(adapter.payBroadcasts).toBe(1); expect((await request(worker, '/api/invoices/presentation_invoice/pay', {}, 'duplicate-new-key')).data.code).toBe('INVALID_STATUS');
  });
  it('keeps native deposits idempotent across reopening SQLite and blocks conflicting or forged retries', async () => {
    const employer = await login('owner'); const path = '/api/vaults/native_tempo/deposit';
    expect((await request(employer, path, { amount: '100000000' }, 'funding', origin, 'forged')).response.status).toBe(403);
    expect((await request(employer, path, { amount: '100000000' }, 'funding')).data.vaults[0].balance).toBe('20100000000');
    await stop(); await start();
    expect((await request(employer, path + '?trace=retry', { amount: '100000000' }, 'funding')).data.vaults[0].balance).toBe('20100000000'); expect(adapter.depositBroadcasts).toBe(1);
    expect((await request(employer, path, { amount: '1' }, 'funding')).data.code).toBe('IDEMPOTENCY_CONFLICT');
    const state = await bootstrap(employer); expect(state.activities.filter(a => a.type === 'deposit')).toHaveLength(1); const csv = await request(employer, '/api/exports/ledger'); expect(csv.data).toContain('TEMPO_MODERATO_TESTNET'); expect(csv.data).not.toContain('LOCAL_SIMULATION');
  });
  it('preserves last verified balances during an outage and blocks all native writes', async () => {
    const employer = await login('owner'), initial = await bootstrap(employer); adapter.outage = true;
    const stale = await bootstrap(employer); expect(stale.native?.status).toBe('stale'); expect(stale.native?.blockNumber).toBe(initial.native?.blockNumber); expect(stale.vaults[0]!.balance).toBe(initial.vaults[0]!.balance); expect(stale.vaults[0]!.settlementAvailable).toBe(false);
    expect((await request(employer, '/api/vaults/native_tempo/deposit', { amount: '1' }, 'outage')).data.code).toBe('NATIVE_UNAVAILABLE'); expect(adapter.depositBroadcasts).toBe(0);
    adapter.outage = false; expect((await request(employer, '/api/vaults/native_tempo/deposit', { amount: '1' }, 'outage')).response.status).toBe(200);
  });
  it('rejects simulated controls and protects native claim reserves and retirement', async () => {
    const { employer } = await readyCommit();
    for (const [path, body] of [['/api/demo/reset', {}], ['/api/demo/advance', { hours: 1 }], ['/api/workers/presentation_worker/block', { blocked: true }], ['/api/vaults/native_tempo/simulate', { event: 'loss', amount: '1' }], ['/api/vaults/native_tempo/allocate', { amount: '1' }]] as const) expect((await request(employer, path, body, `denied-${path.replaceAll('/', '-')}`)).data.code).toBe('REAL_ACTION_UNAVAILABLE');
    expect((await request(employer, '/api/vaults/native_tempo/withdraw', { amount: '20000000000' }, 'over-reserve')).data.code).toBe('RESERVE_PROTECTED'); expect((await request(employer, '/api/vaults/native_tempo/retire', {}, 'retire')).data.code).toBe('OUTSTANDING_COMMITMENTS');
    expect((await request(employer, '/api/invoices/presentation_invoice/pay', {}, 'pay')).response.status).toBe(200); const retired = await request(employer, '/api/vaults/native_tempo/retire', {}, 'retire'); expect(retired.response.status).toBe(200); expect(retired.data.vaults[0]).toMatchObject({ retired: true, buffer: '0' });
  });
  it('new owners start unavailable and explicitly provision before creating managed contractors and invitations', async () => {
    const employer: Client = {}; expect((await request(employer, '/api/auth/register', { name: 'New Owner', email: 'native-owner@example.org', password: 'Correct horse 42!', companyName: 'Native Company' })).response.status).toBe(200);
    const pending = await bootstrap(employer); expect(pending.mode).toBe('testnet'); expect(pending.vaults).toEqual([]); expect(pending.native?.status).toBe('unavailable'); expect(adapter.provisionCalls).toBe(0);
    expect((await request(employer, '/api/native/provision', {}, 'provision')).response.status).toBe(200); expect(adapter.provisionCalls).toBe(1);
    expect((await request(employer, '/api/workers', { name: 'Worker', email: 'worker@example.org', rail: 'tempo', address: '0x' + '1'.repeat(40) }, 'external')).data.code).toBe('MANAGED_TEST_WALLET_REQUIRED');
    const input = { name: 'Worker', email: 'worker@example.org', rail: 'tempo' }; const created = await request(employer, '/api/workers', input, 'worker-create'); expect(created.response.status).toBe(200); expect(created.data.workers[0]).toMatchObject({ rail: 'tempo', managedTestWallet: true, confirmed: false });
    expect((await request(employer, '/api/workers', input, 'worker-create')).data.workers).toHaveLength(1);
    const id = created.data.workers[0].id; const invitation = await request(employer, `/api/workers/${id}/invitation`, {}), token = new URL(invitation.data.url).searchParams.get('token')!;
    const worker: Client = {}; expect((await request(worker, '/api/auth/register-worker', { name: 'Worker', email: 'worker@example.org', password: 'Correct worker 42!', invitationToken: token })).response.status).toBe(200); expect((await request(worker, `/api/workers/${id}/confirm`, {}, 'confirm')).response.status).toBe(200); expect((await bootstrap(worker)).workers).toHaveLength(1);
    expect((await request(worker, '/api/native/provision', {}, 'forbidden')).response.status).toBe(403);
    expect((await request(worker, '/api/company/formation', { provider: 'atlas' })).response.status).toBe(403); const handoff = await request(employer, '/api/company/formation', { provider: 'atlas' }); expect(handoff.data.statement).toContain('No company'); expect((await bootstrap(employer)).company.bankingStatus).toBe('not_requested');
  });
  it('does not overwrite metadata changed during an awaited native refresh', async () => {
    const employer = await login('owner'); await bootstrap(employer);
    let entered!: () => void, release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    adapter.syncBarrier = async () => { entered(); await barrier; }; const reading = request(employer, '/api/bootstrap'); await waiting;
    expect((await request(employer, '/api/company', { name: 'Updated during RPC' }, 'company')).response.status).toBe(200);
    expect((await request(employer, '/api/invoices', { workerId: 'presentation_worker', description: 'Added during RPC', amount: '1', dueAt: new Date(time).toISOString(), rail: 'tempo' }, 'new-invoice')).response.status).toBe(200);
    release(); const finished = await reading; adapter.syncBarrier = undefined; expect(finished.data.company.name).toBe('Updated during RPC'); expect(finished.data.invoices).toHaveLength(2);
  });
  it('retains a signed pending hash, reconciles without rebroadcasting, and preserves the stable invoice ID', async () => {
    const employer = await login('owner'), worker = await login('worker'); await request(worker, '/api/workers/presentation_worker/confirm', {}, 'confirm'); adapter.pendingCommit = true;
    const pending = await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'pending-commit'); expect(pending.response.status).toBe(503); expect(pending.data.code).toBe('NATIVE_PENDING');
    const state = await bootstrap(employer); expect(state.invoices[0]!.status).toBe('approved'); expect(state.invoices[0]!.nativePending?.hash).toMatch(/^0x/); expect(state.invoices[0]!.paymentId).toBe(nativePaymentId('presentation_tempo', 'presentation_invoice'));
    adapter.reconcile('presentation_tempo', service.store.organization('presentation_tempo').invoices[0]!); await stop(); await start();
    const reconciled = await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'pending-commit'); expect(reconciled.response.status).toBe(200); expect(reconciled.data.invoices[0].status).toBe('committed'); expect(reconciled.data.invoices[0].nativePending).toBeUndefined(); expect(adapter.commitBroadcasts).toBe(1);
  });
  it('clears pending display after a definitive rejection and does not invent a commitment', async () => {
    const employer = await login('owner'), worker = await login('worker'); await request(worker, '/api/workers/presentation_worker/confirm', {}, 'confirm'); adapter.rejectCommit = true;
    const rejected = await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'rejected'); expect(rejected.data.code).toBe('NATIVE_REJECTED'); expect((await bootstrap(employer)).invoices[0]).toMatchObject({ status: 'approved' }); expect((await bootstrap(employer)).invoices[0]!.nativePending).toBeUndefined(); expect(adapter.commitBroadcasts).toBe(0);
    adapter.rejectCommit = false; expect((await request(employer, '/api/invoices/presentation_invoice/commit', {}, 'rejected')).response.status).toBe(200);
  });
  it('withholds a paid receipt until the actual settlement hash is indexed', async () => {
    const { worker } = await readyCommit(), claim = adapter.claims.get('presentation_tempo:presentation_invoice')!;
    adapter.claims.set('presentation_tempo:presentation_invoice', { ...claim, status: 'paid', transactionRef: claim.commitTransactionRef }); adapter.balances.set('presentation_tempo', adapter.balances.get('presentation_tempo')! - 300_000_000n);
    const paid = await bootstrap(worker); expect(paid.invoices[0]!.status).toBe('paid'); expect(paid.invoices[0]!.transactionRef).toBeUndefined(); expect((await request(worker, '/api/receipts/presentation_invoice')).data.code).toBe('CHAIN_RECEIPT_UNAVAILABLE');
    const settlement = adapter.result(); adapter.claims.set('presentation_tempo:presentation_invoice', { ...claim, status: 'paid', transactionRef: settlement.hash }); expect((await request(worker, '/api/receipts/presentation_invoice')).data.transactionRef).toBe(settlement.hash);
  });
  it('isolates worker claims, forbids user key input and requires stable native operation keys', async () => {
    const employer = await login('owner'), worker = await login('worker');
    const created = await request(employer, '/api/workers', { name: 'Other', email: 'other@example.org', rail: 'tempo' }, 'other'); const other = created.data.workers.find((value: Worker) => value.id !== 'presentation_worker');
    const invoice = await request(employer, '/api/invoices', { workerId: other.id, description: 'Private', amount: '1', dueAt: new Date(time).toISOString(), rail: 'tempo' }, 'private'); const otherInvoice = invoice.data.invoices.find((value: Invoice) => value.workerId === other.id);
    expect((await request(worker, `/api/invoices/${otherInvoice.id}/pay`, {}, 'private-pay')).response.status).toBe(404); expect((await request(worker, `/api/receipts/${otherInvoice.id}`)).response.status).toBe(404); const own = await bootstrap(worker); expect(own.workers).toHaveLength(1); expect(own.invoices).toHaveLength(1);
    expect((await request(employer, '/api/vaults/native_tempo/deposit', { amount: '1' })).data.code).toBe('IDEMPOTENCY_KEY_REQUIRED'); expect((await request(employer, '/api/native/provision', { privateKey: 'do-not-accept' }, 'key-input')).response.status).toBe(400);
  });
});
