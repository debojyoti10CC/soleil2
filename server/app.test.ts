import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session, Snapshot } from '../src/shared/types.js';
import { createApp } from './app.js';

const origin = 'http://localhost:5173';
const time = Date.parse('2026-01-01T00:00:00Z');
interface Client { cookie?: string; csrf?: string; session?: Session; }
describe('persistent tenant-scoped API', () => {
  let service: ReturnType<typeof createApp>, server: Server, base: string, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'soleil-api-')); service = createApp({ databasePath: join(directory, 'test.sqlite'), demoEnabled: true, clock: () => time }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); service.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(client: Client, path: string, body?: unknown, settings: { origin?: string; csrf?: string; method?: string; idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = { origin: settings.origin ?? origin };
    if (client.cookie) headers.cookie = client.cookie;
    if (client.csrf) headers['x-csrf-token'] = settings.csrf ?? client.csrf;
    if (settings.idempotencyKey) headers['x-idempotency-key'] = settings.idempotencyKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method: settings.method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) client.cookie = setCookie.split(';')[0];
    const data = response.status === 204 ? null : response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    if (data?.csrfToken) { client.csrf = data.csrfToken; client.session = data; }
    return { response, data };
  }
  async function demo(role: 'owner' | 'worker'): Promise<Client> { const client: Client = {}; const r = await request(client, '/api/auth/demo', { role }); expect(r.response.status).toBe(200); return client; }
  async function register(email: string): Promise<Client> { const client: Client = {}; const r = await request(client, '/api/auth/register', { name: 'New Owner', email, password: 'Correct horse 42!', companyName: 'New Company' }); expect(r.response.status).toBe(200); return client; }
  it('identifies this service, requires sessions and exposes only nonsensitive public configuration', async () => { expect((await request({}, '/api/health')).data).toMatchObject({ ok: true, service: 'soleil' }); expect((await request({}, '/api/bootstrap')).response.status).toBe(401); const r = await request({}, '/api/config'); expect(r.data.demoEnabled).toBe(true); expect(r.data.bridgeConfigured).toBe(false); expect(JSON.stringify(r.data)).not.toContain('password'); });
  it('uses HttpOnly SameSite cookies and rejects forged CSRF and cross-origin auth', async () => {
    const client: Client = {}; const r = await request(client, '/api/auth/demo', { role: 'owner' }); expect(r.response.headers.get('set-cookie')).toContain('HttpOnly'); expect(r.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect((await request(client, '/api/company', { name: 'Wrong' }, { csrf: 'forged' })).response.status).toBe(403);
    expect((await request({}, '/api/auth/demo', { role: 'owner' }, { origin: 'https://attacker.example' })).response.status).toBe(403);
    expect((await request(client, '/api/company', { name: 'Valid' })).response.status).toBe(200);
  });
  it('new registration has zero funds, survives relogin, and stores scrypt rather than plaintext', async () => {
    const client = await register('new@example.org'); const bootstrap = await request(client, '/api/bootstrap'); expect(bootstrap.data.vaults.every((v: { balance: string }) => v.balance === '0')).toBe(true); expect(bootstrap.data.mode).toBe('demo');
    const row = service.store.userByEmail('new@example.org')!; expect(row.password_hash).toMatch(/^scrypt\$16384\$/); expect(row.password_hash).not.toContain('Correct horse');
    await request(client, '/api/auth/logout', {}); expect((await request(client, '/api/bootstrap')).response.status).toBe(401);
    expect((await request(client, '/api/auth/login', { email: 'new@example.org', password: 'wrong' })).response.status).toBe(401);
    expect((await request(client, '/api/auth/login', { email: 'new@example.org', password: 'Correct horse 42!' })).response.status).toBe(200);
    expect((await request(client, '/api/bootstrap')).data.company.id).toBe(bootstrap.data.company.id);
  });
  it('persists organization and session state across reopening SQLite', async () => {
    const client = await register('persistent@example.org'); await request(client, '/api/company', { name: 'Persisted Name' });
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); service.close();
    service = createApp({ databasePath: join(directory, 'test.sqlite'), demoEnabled: true, clock: () => time }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await request(client, '/api/bootstrap')).data.company.name).toBe('Persisted Name');
  });
  it('worker snapshots and receipts cannot expose other contractors or owner actions', async () => {
    const employer = await demo('owner'), worker = await demo('worker'); const all = (await request(employer, '/api/bootstrap')).data as Snapshot; const own = (await request(worker, '/api/bootstrap')).data as Snapshot;
    expect(own.workers).toHaveLength(1); expect(own.invoices.every(i => i.workerId === worker.session!.user.workerId)).toBe(true);
    const otherInvoice = all.invoices.find(i => i.status === 'committed' && i.workerId !== worker.session!.user.workerId)!;
    expect((await request(worker, `/api/receipts/${otherInvoice.id}`)).response.status).toBe(404); expect((await request(worker, '/api/company', { name: 'Hijacked' })).response.status).toBe(403); expect((await request(worker, '/api/exports/ledger')).response.status).toBe(403);
    expect((await request(worker, `/api/invoices/${otherInvoice.id}/pay`, {})).response.status).toBe(404);
  });
  it('other organizations cannot address tenant records even with valid authentication', async () => {
    const employer = await demo('owner'), other = await register('other@example.org'); const all = (await request(employer, '/api/bootstrap')).data as Snapshot;
    expect((await request(other, `/api/invoices/${all.invoices[0]!.id}/approve`, {})).response.status).toBe(404);
    expect((await request(other, `/api/vaults/${all.vaults[0]!.id}/deposit`, { amount: '1' })).response.status).toBe(404);
    expect((await request(other, `/api/workers/${all.workers[0]!.id}/invitation`, {})).response.status).toBe(404);
  });
  it('persistent operation keys prevent repeated amount-changing requests and reject conflicting reuse', async () => {
    const employer = await register('idempotency@example.org'); const before = (await request(employer, '/api/bootstrap')).data as Snapshot; const vault = before.vaults[0]!; const key = 'deposit-operation-1';
    expect((await request(employer, `/api/vaults/${vault.id}/deposit`, { amount: '9007199254740993' }, { idempotencyKey: key })).response.status).toBe(200);
    expect((await request(employer, `/api/vaults/${vault.id}/deposit`, { amount: '9007199254740993' }, { idempotencyKey: key })).data.vaults[0].balance).toBe('9007199254740993');
    expect((await request(employer, `/api/vaults/${vault.id}/deposit`, { amount: '1' }, { idempotencyKey: key })).response.status).toBe(409);
    const after = (await request(employer, '/api/bootstrap')).data as Snapshot; expect(after.activities.filter(a => a.type === 'deposit')).toHaveLength(1); expect(after.vaults[0]!.balance).toBe('9007199254740993');
  });
  it('failed authorization/domain checks cannot poison a key, and query strings cannot change replay effects', async () => {
    const employer = await register('key-boundaries@example.org'), other = await register('key-other@example.org');
    const initial = (await request(employer, '/api/bootstrap')).data as Snapshot, vault = initial.vaults[0]!, key = 'scoped-safe-operation';
    expect((await request(employer, `/api/vaults/${vault.id}/withdraw`, { amount: '1' }, { idempotencyKey: key })).data.code).toBe('RESERVE_PROTECTED');
    expect((await request(employer, `/api/vaults/${vault.id}/deposit`, { amount: '1' }, { csrf: 'forged', idempotencyKey: key })).response.status).toBe(403);
    expect((await request(employer, `/api/vaults/${vault.id}/deposit?amount=999`, { amount: '1' }, { idempotencyKey: key })).data.vaults[0].balance).toBe('1');
    expect((await request(employer, `/api/vaults/${vault.id}/deposit?trace=changed`, { amount: '1' }, { idempotencyKey: key })).data.vaults[0].balance).toBe('1');
    const otherVault = ((await request(other, '/api/bootstrap')).data as Snapshot).vaults[0]!;
    expect((await request(other, `/api/vaults/${otherVault.id}/deposit`, { amount: '2' }, { idempotencyKey: key })).data.vaults[0].balance).toBe('2');
  });
  it('owner cannot confirm a worker; matching worker can confirm then independently settle', async () => {
    const employer = await demo('owner'), worker = await demo('worker'); const own = (await request(worker, '/api/bootstrap')).data as Snapshot; const w = own.workers[0]!; const invoice = own.invoices.find(i => i.status === 'approved')!;
    expect((await request(employer, `/api/workers/${w.id}/confirm`, {})).response.status).toBe(403); expect((await request(employer, `/api/invoices/${invoice.id}/commit`, {})).data.code).toBe('RECIPIENT_UNCONFIRMED');
    expect((await request(worker, `/api/workers/${w.id}/confirm`, {})).response.status).toBe(200); expect((await request(employer, `/api/invoices/${invoice.id}/commit`, {})).response.status).toBe(200);
    expect((await request(worker, `/api/invoices/${invoice.id}/pay`, {})).data.code).toBe('NOT_DUE'); await request(employer, '/api/demo/advance', { hours: 49 });
    expect((await request(worker, `/api/invoices/${invoice.id}/pay`, {})).response.status).toBe(200); const r = await request(worker, `/api/receipts/${invoice.id}`); expect(r.data.status).toBe('paid'); expect(r.data.statement).toContain('Local simulation'); expect(r.data.transactionRef).toMatch(/^sim_/);
    expect((await request(worker, `/api/invoices/${invoice.id}/pay`, {})).response.status).toBe(400);
  });
  it('atomically rejects blocked payouts and mixed-validity batches in persistent storage', async () => {
    const employer = await demo('owner'); const all = (await request(employer, '/api/bootstrap')).data as Snapshot; const mature = all.invoices.find(i => i.rail === 'tempo' && i.status === 'committed')!;
    await request(employer, `/api/workers/${mature.workerId}/block`, { blocked: true }); const before = (await request(employer, '/api/bootstrap')).data;
    expect((await request(employer, `/api/invoices/${mature.id}/pay`, {})).data.code).toBe('RECIPIENT_BLOCKED'); const after = (await request(employer, '/api/bootstrap')).data; expect(after).toEqual(before);
    await request(employer, `/api/workers/${mature.workerId}/block`, { blocked: false }); const beforeBatch = (await request(employer, '/api/bootstrap')).data;
    expect((await request(employer, '/api/invoices/batch/pay', { ids: [mature.id, all.invoices.find(i => i.status === 'draft')!.id] })).response.status).toBe(400); expect((await request(employer, '/api/bootstrap')).data).toEqual(beforeBatch);
  });
  it('invites are tenant-scoped, rotated, single-use, and create usable worker accounts', async () => {
    const employer = await register('invite-owner@example.org'); const created = await request(employer, '/api/workers', { name: 'Invited Person', email: 'invited@example.org', address: 'sim_invited', rail: 'solana' }); const workerId = created.data.workers[0].id;
    const first = await request(employer, `/api/workers/${workerId}/invitation`, {}), token1 = new URL(first.data.url).searchParams.get('token')!;
    const second = await request(employer, `/api/workers/${workerId}/invitation`, {}), token2 = new URL(second.data.url).searchParams.get('token')!; expect(token2).not.toBe(token1);
    expect((await request({}, `/api/auth/invitation?token=${token1}`)).response.status).toBe(404); expect((await request({}, `/api/auth/invitation?token=${token2}`)).data.email).toBe('invited@example.org');
    expect((await request({}, '/api/auth/register-worker', { name: 'Worker', email: 'different@example.org', password: 'A strong password', invitationToken: token2 })).response.status).toBe(409);
    const worker: Client = {}; expect((await request(worker, '/api/auth/register-worker', { name: 'Worker', email: 'invited@example.org', password: 'A strong password', invitationToken: token2 })).response.status).toBe(200);
    expect(worker.session!.user.role).toBe('worker'); expect(worker.session!.user.organizationId).toBe(employer.session!.user.organizationId); expect((await request({}, `/api/auth/invitation?token=${token2}`)).response.status).toBe(404);
    expect((await request(worker, '/api/bootstrap')).data.workers).toHaveLength(1); expect((await request(worker, `/api/workers/${workerId}/confirm`, {})).response.status).toBe(200);
  });
  it('rejects expired invitations without leaking provider or account state', async () => {
    const employer = await register('expired-owner@example.org'); const created = await request(employer, '/api/workers', { name: 'Expired', email: 'expired@example.org', address: 'sim_expired', rail: 'tempo' }); const invitation = await request(employer, `/api/workers/${created.data.workers[0].id}/invitation`, {}); const token = new URL(invitation.data.url).searchParams.get('token')!;
    service.store.db.prepare('UPDATE invitations SET expires_at=?').run(time - 1); expect((await request({}, `/api/auth/invitation?token=${token}`)).response.status).toBe(404);
  });
  it('provider handoff cannot silently mark formation, KYB or banking approved; exports identify simulation', async () => {
    const employer = await demo('owner'); const r = await request(employer, '/api/company/formation', { provider: 'atlas' }); expect(r.data.url).toBe('https://dashboard.stripe.com/atlas'); expect(r.data.statement).toContain('No company'); const s = (await request(employer, '/api/bootstrap')).data as Snapshot;
    expect(s.company.formationStatus).toBe('handoff_requested'); expect(s.company.verificationStatus).toBe('not_started'); expect(s.company.bankingStatus).toBe('not_requested'); const csv = await request(employer, '/api/exports/ledger'); expect(csv.data).toContain('LOCAL_SIMULATION'); expect(csv.response.headers.get('content-disposition')).toContain('.csv');
  });
  it('resets only the seeded company and new owners cannot use demo clock travel', async () => {
    const employer = await demo('owner'), other = await register('no-reset@example.org'); expect((await request(other, '/api/demo/reset', {})).response.status).toBe(403); expect((await request(other, '/api/demo/advance', { hours: 1 })).response.status).toBe(403);
    await request(employer, '/api/company', { name: 'Changed' }); expect((await request(employer, '/api/demo/reset', {})).data.company.name).toBe('Soleil Studio');
  });
  it('disables every simulated financial mutation when demo configuration is off', async () => {
    const client = await register('disabled@example.org'); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); service.close();
    service = createApp({ databasePath: join(directory, 'test.sqlite'), demoEnabled: false, clock: () => time }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await request({}, '/api/auth/demo', { role: 'owner' })).response.status).toBe(403); const s = (await request(client, '/api/bootstrap')).data as Snapshot; expect((await request(client, `/api/vaults/${s.vaults[0]!.id}/deposit`, { amount: '1' })).response.status).toBe(403);
  });
});
