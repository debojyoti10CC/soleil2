import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { verifyMessage } from 'viem';
import type { PublicConfig, Session, User } from '../src/shared/types.js';
import { addWorker, advanceClock, allocate, approveInvoice, blockWorker, commitInvoice, confirmWorker, createInvoice, deposit, DomainError, findInvoice, findWorker, invoiceAccess, now, owner, payInvoices, receipt, retire, simulateStrategy, snapshot, units, withdraw, type OrganizationState } from './domain.js';
import { digest, passwordHash, passwordMatches, Store, type StoredSession } from './store.js';
import { createTestnetRelay } from './testnet-rpc.js';
import { applyNativeBundle, nativeActivity, nativePaymentId, nativePosting, NativeWorkspaceCoordinator, validateNativeCommit, type NativeWorkspaceAdapter } from './native-workspace.js';

export interface AppOptions { databasePath?: string; demoEnabled?: boolean; allowedOrigins?: string[]; appOrigin?: string; publicConfig?: Partial<PublicConfig>; clock?: () => number; staticDirectory?: string; rpcFetch?: typeof fetch; native?: NativeWorkspaceAdapter; }
const text = (max = 120) => z.string().trim().min(1).max(max);
const email = z.email().max(254).transform(v => v.trim().toLowerCase());
const password = z.string().min(8, 'Use at least 8 characters.').max(128);
const amount = z.string().regex(/^[1-9]\d{0,38}$/, 'Use a positive integer base-unit amount.');
const rail = z.enum(['solana', 'tempo']);
const cookieName = 'soleil_session';
const parseCookie = (req: Request) => (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
const sessionSymbol = Symbol('session');
type AuthRequest = Request & { [sessionSymbol]?: StoredSession };
function auth(req: Request): StoredSession { const s = (req as AuthRequest)[sessionSymbol]; if (!s) throw new DomainError('Sign in to continue.', 'UNAUTHENTICATED', 401); return s; }
function equalSecret(a: string, b: string) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function safeCsv(value: string) { const clean = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${clean.replaceAll('"', '""')}"`; }
export function createApp(options: AppOptions = {}) {
  const app = express(), store = new Store(options.databasePath ?? resolve('data', 'soleil.sqlite'));
  const clock = options.clock ?? Date.now, demoEnabled = options.demoEnabled === true;
  const native = options.native ? new NativeWorkspaceCoordinator(store, options.native, clock) : undefined;
  const appOrigin = options.appOrigin ?? 'http://localhost:5173';
  const allowedOrigins = new Set(options.allowedOrigins ?? [appOrigin, 'http://localhost:3001', 'http://127.0.0.1:5173', 'http://127.0.0.1:3001']);
  const defaultConfig: PublicConfig = { demoEnabled, bridgeConfigured: false, solana: { rpcUrl: 'https://api.devnet.solana.com', programId: null, mint: null }, tempo: { rpcUrl: 'https://rpc.moderato.tempo.xyz', chainId: 42431, vaultAddress: null, tokenAddress: null } };
  const config: PublicConfig = { ...defaultConfig, ...options.publicConfig, demoEnabled };
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', (req, _res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const origin = req.get('origin');
        if (!origin || !allowedOrigins.has(origin)) throw new DomainError('This request must come from the Soleil application origin.', 'INVALID_ORIGIN', 403);
        const fetchSite = req.get('sec-fetch-site');
        if (fetchSite === 'cross-site') throw new DomainError('Cross-site requests are not allowed.', 'INVALID_ORIGIN', 403);
      }
      const token = parseCookie(req);
      if (token) (req as AuthRequest)[sessionSymbol] = store.session(token, clock());
      next();
    } catch (error) { next(error); }
  });
  const requireSession = (req: Request, _res: Response, next: NextFunction) => { try { auth(req); next(); } catch (error) { next(error); } };
  const csrf = (req: Request, _res: Response, next: NextFunction) => {
    try { const s = auth(req); if (!equalSecret(req.get('x-csrf-token') ?? '', s.csrfToken)) throw new DomainError('Refresh the page before retrying this request.', 'INVALID_CSRF', 403); next(); } catch (error) { next(error); }
  };
  const requireDemo = (_req: Request, _res: Response, next: NextFunction) => { if (!demoEnabled) next(new DomainError('Local simulation controls are disabled.', 'DEMO_DISABLED', 403)); else next(); };
  const attempts = new Map<string, { count: number; expires: number }>();
  const authLimit = (req: Request, _res: Response, next: NextFunction) => {
    const time = clock(), key = req.ip ?? 'unknown', current = attempts.get(key);
    if (!current || current.expires <= time) attempts.set(key, { count: 1, expires: time + 60_000 });
    else if (++current.count > 30) { next(new DomainError('Too many sign-in attempts. Try again shortly.', 'RATE_LIMITED', 429)); return; }
    if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.expires <= time) attempts.delete(k);
    next();
  };
  const issueSession = (req: Request, res: Response, user: User) => {
    const old = parseCookie(req); if (old) store.deleteSession(old);
    const s = store.createSession(user, clock());
    res.cookie(cookieName, s.token, { httpOnly: true, sameSite: 'strict', secure: appOrigin.startsWith('https:'), path: '/', maxAge: s.expiresAt - clock() });
    const response: Session = { user, csrfToken: s.csrfToken, demoEnabled }; res.json(response);
  };
  const requestOperation = (req: Request, required = false) => {
    const actor = auth(req).user, key = req.get('x-idempotency-key');
    if (key && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new DomainError('Use an operation key of 1–128 simple characters.', 'INVALID_IDEMPOTENCY_KEY');
    if (required && !key) throw new DomainError('A stable operation key is required for native transactions and retries.', 'IDEMPOTENCY_KEY_REQUIRED');
    return key ? { userId: actor.id, key, fingerprint: digest(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? {})}`), now: clock() } : undefined;
  };
  const mutate = (req: Request, res: Response, fn: (state: OrganizationState, actor: User) => unknown) => {
    const actor = auth(req).user, operation = requestOperation(req);
    const { state } = store.mutate(actor.organizationId, state => fn(state, actor), operation); res.json(snapshot(state, actor, clock()));
  };
  const nativeFor = (req: Request) => store.organization(auth(req).user.organizationId).mode === 'testnet';
  const requireLocalNative = (req: Request) => {
    const remote = req.socket.remoteAddress ?? '', origin = req.get('origin');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || !origin || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new DomainError('Generated test-wallet operations require a local application origin and connection.', 'NATIVE_LOCAL_ONLY', 403);
  };
  const financialAccess = (req: Request, _res: Response, next: NextFunction) => {
    try { if (nativeFor(req)) { if (!native) throw new DomainError('The native Tempo adapter is unavailable.', 'NATIVE_UNAVAILABLE', 503); requireLocalNative(req); } else if (!demoEnabled) throw new DomainError('Local simulation controls are disabled.', 'DEMO_DISABLED', 403); next(); } catch (error) { next(error); }
  };
  const nativeWrite = async (req: Request, res: Response, callbacks: Parameters<NativeWorkspaceCoordinator['write']>[3]) => {
    if (!native) throw new DomainError('The native Tempo adapter is unavailable.', 'NATIVE_UNAVAILABLE', 503);
    const actor = auth(req).user, operation = requestOperation(req, true)!;
    const state = await native.write(actor, operation.key, operation.fingerprint, callbacks); res.json(snapshot(state, actor, clock()));
  };
  const readState = async (actor: User) => { const state = store.organization(actor.organizationId); return state.mode === 'testnet' && native ? native.read(actor.organizationId) : state; };
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'soleil', mode: native ? 'native-testnet' : 'local-simulation' }));
  app.get('/api/config', (_req, res) => {
    const bundle = options.native?.cachedBundle('presentation_tempo');
    res.json({ ...config, presentationEnabled: !!native, presentationReady: !!bundle, tempo: bundle ? { ...config.tempo, chainId: 42431, vaultAddress: bundle.vaultAddress, tokenAddress: bundle.tokenAddress } : config.tempo });
  });
  app.get('/api/auth/session', requireSession, (req, res) => { const s = auth(req); res.json({ user: s.user, csrfToken: s.csrfToken, demoEnabled }); });
  app.post('/api/auth/demo', authLimit, requireDemo, (req, res) => { const input = z.object({ role: z.enum(['owner', 'worker']) }).strict().parse(req.body); issueSession(req, res, store.demoUser(input.role, clock())); });
  app.post('/api/auth/presentation', authLimit, (req, res) => {
    const input = z.object({ role: z.enum(['owner', 'worker']) }).strict().parse(req.body); requireLocalNative(req);
    const bundle = options.native?.cachedBundle('presentation_tempo');
    if (!bundle) throw new DomainError('The native presentation vault has not been prepared. Run the local preparation command before signing in.', 'PRESENTATION_NOT_READY', 503);
    issueSession(req, res, store.presentationUser(input.role, bundle, clock()));
  });
  app.post('/api/auth/register', authLimit, async (req, res) => {
    const input = z.object({ name: text(), email, password, companyName: text() }).strict().parse(req.body);
    if (input.email.endsWith('@soleil.local')) throw new DomainError('This email domain is reserved for local demo accounts.', 'RESERVED_EMAIL');
    issueSession(req, res, store.registerOwner(input, await passwordHash(input.password), !!native));
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const input = z.object({ email, password: z.string().min(1).max(128) }).strict().parse(req.body), user = store.userByEmail(input.email);
    // Always do the password work, including for unknown accounts, to avoid a cheap account-existence signal.
    const encoded = user?.password_hash.startsWith('scrypt$') ? user.password_hash : 'scrypt$16384$00000000000000000000000000000000$' + '0'.repeat(128);
    const matches = await passwordMatches(input.password, encoded);
    if (!matches || !user || !user.password_hash.startsWith('scrypt$')) throw new DomainError('Email or password is incorrect.', 'INVALID_CREDENTIALS', 401);
    issueSession(req, res, store.getUser(input.email)!);
  });
  app.get('/api/auth/invitation', authLimit, (req, res) => {
    const token = z.string().min(20).max(100).parse(req.query.token); const { worker, state } = store.invitation(token, clock());
    res.json({ name: worker.name, email: worker.email, companyName: state.company.name, address: worker.address, rail: worker.rail });
  });
  app.post('/api/auth/register-worker', authLimit, async (req, res) => {
    const input = z.object({ name: text(), email, password, invitationToken: z.string().min(20).max(100) }).strict().parse(req.body);
    issueSession(req, res, store.registerWorker(input, await passwordHash(input.password), clock()));
  });
  app.post('/api/auth/logout', requireSession, csrf, (req, res) => { store.deleteSession(parseCookie(req)); res.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: appOrigin.startsWith('https:') }); res.status(204).end(); });
  // The relay accepts only a fixed free-testnet upstream and an explicit method allowlist.
  // Public same-origin reads support the independent verifier without a Soleil account.
  app.post('/api/testnet/rpc', (_req, _res, next) => { if (!demoEnabled && !native) next(new DomainError('Testnet access is disabled.', 'TESTNET_DISABLED', 403)); else next(); }, createTestnetRelay(options.rpcFetch, clock));

  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/config' || req.path.startsWith('/auth/')) { next(); return; }
    requireSession(req, res, error => { if (error) { next(error); return; } if (req.method === 'GET' || req.method === 'HEAD') next(); else csrf(req, res, next); });
  });
  app.get('/api/bootstrap', async (req, res) => { const actor = auth(req).user; res.json(snapshot(await readState(actor), actor, clock())); });
  app.post('/api/native/provision', financialAccess, async (req, res) => {
    z.object({}).strict().parse(req.body ?? {}); const actor = auth(req).user; owner(actor);
    if (!native || !nativeFor(req)) throw new DomainError('Native provisioning is available only for a native testnet company.', 'NATIVE_UNAVAILABLE', 409);
    const state = await native.exclusive(actor.organizationId, async () => {
      const bundle = await native.adapter.provision(actor.organizationId);
      store.mutate(actor.organizationId, state => applyNativeBundle(state, bundle));
      return native.refresh(actor.organizationId);
    }); res.json(snapshot(state, actor, clock()));
  });
  app.post('/api/workers', async (req, res) => {
    const input = z.object({ name: text(), email, address: z.string().trim().max(256).optional(), rail }).strict().parse(req.body), actor = auth(req).user; owner(actor);
    const initial = store.organization(actor.organizationId);
    if (!initial.demoOrganization && input.email.endsWith('@soleil.local')) throw new DomainError('This email domain is reserved for seeded local accounts.', 'RESERVED_EMAIL');
    if (initial.mode !== 'testnet') { if (!input.address) throw new DomainError('Enter a receiving address.', 'VALIDATION_ERROR'); mutate(req, res, (s, actor) => addWorker(s, actor, { ...input, address: input.address! }, clock())); return; }
    requireLocalNative(req);
    if (!native || !native.adapter.cachedBundle(actor.organizationId)) throw new DomainError('Provision the native company vault before adding a test receiving wallet.', 'NATIVE_UNAVAILABLE', 409);
    if (input.rail !== 'tempo') throw new DomainError('Only native Tempo test receiving wallets are currently supported.', 'UNSUPPORTED_RAIL', 409);
    if (input.address) throw new DomainError('External wallet confirmation is not implemented. Leave the address empty to generate a clearly labelled server-controlled test wallet.', 'MANAGED_TEST_WALLET_REQUIRED', 409);
    const operation = requestOperation(req);
    if (operation && store.completedOperation(actor.id, operation.key, operation.fingerprint, clock())) { res.json(snapshot(initial, actor, clock())); return; }
    if (initial.workers.some(w => w.email.toLowerCase() === input.email)) throw new DomainError('A contractor with this email already exists.', 'DUPLICATE_WORKER', 409);
    const workerId = operation ? `worker_${digest(`${actor.id}:${operation.key}`).slice(0, 32)}` : `worker_${randomUUID()}`;
    const address = await native.adapter.managedWorker(actor.organizationId, workerId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new DomainError('The generated test wallet is invalid.', 'NATIVE_CONFIGURATION', 503);
    const { state } = store.mutate(actor.organizationId, s => { const worker = addWorker(s, actor, { ...input, address }, clock()); const originalId = worker.id; worker.id = workerId; worker.managedTestWallet = true; for (const activity of s.activities) if (activity.workerId === originalId) activity.workerId = workerId; }, operation);
    res.json(snapshot(state, actor, clock()));
  });
  app.post('/api/workers/:id/invitation', (req, res) => {
    const actor = auth(req).user; owner(actor); const token = store.invite(actor, String(req.params.id), clock()); const url = new URL('/invite', appOrigin); url.searchParams.set('token', token); res.json({ url: url.toString() });
  });
  app.post('/api/workers/:id/confirm', financialAccess, async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    if (!nativeFor(req)) { mutate(req, res, (s, actor) => confirmWorker(s, actor, String(req.params.id), clock())); return; }
    const actor = auth(req).user, state = store.organization(actor.organizationId), worker = findWorker(state, String(req.params.id));
    if (actor.role !== 'worker' || actor.workerId !== worker.id) throw new DomainError('Only this contractor can acknowledge their test receiving wallet.', 'FORBIDDEN', 403);
    if (!worker.managedTestWallet || !native) throw new DomainError('A supported generated test wallet is required.', 'MANAGED_TEST_WALLET_REQUIRED', 409);
    const proof = await native.adapter.confirmManagedWorker(actor.organizationId, worker);
    if (proof.address.toLowerCase() !== worker.address.toLowerCase() || !await verifyMessage({ address: worker.address as `0x${string}`, message: proof.message, signature: proof.signature as `0x${string}` })) throw new DomainError('The generated test-wallet signature could not be verified.', 'INVALID_ACCOUNT_PROOF', 409);
    mutate(req, res, (s, actor) => {
      const target = findWorker(s, worker.id); target.confirmed = true; target.confirmationProof = JSON.stringify({ kind: 'server-controlled-generated-test-wallet', ...proof });
      nativeActivity(s, actor, 'Test receiving wallet acknowledged', 'The contractor consented to the server-controlled generated test wallet. Its server-held test key signed a verified acknowledgement; this is not user custody.', 'confirmation', worker.id, worker.id);
    });
  });
  app.post('/api/workers/:id/block', requireDemo, (req, res) => { const input = z.object({ blocked: z.boolean() }).strict().parse(req.body); mutate(req, res, (s, actor) => blockWorker(s, actor, String(req.params.id), input.blocked, clock())); });
  app.post('/api/invoices', (req, res) => { const input = z.object({ workerId: text(), description: text(500), amount, dueAt: z.iso.datetime({ offset: true }), rail }).strict().parse(req.body); mutate(req, res, (s, actor) => createInvoice(s, actor, input, clock())); });
  const settleNative = async (req: Request, res: Response, ids: string[], batch = false) => {
    const actor = auth(req).user;
    if (batch) owner(actor);
    if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw new DomainError('Choose 1–32 distinct native invoices.', 'INVALID_BATCH');
    const initial = store.organization(actor.organizationId);
    for (const id of ids) invoiceAccess(actor, findInvoice(initial, id));
    await nativeWrite(req, res, {
      validate: state => {
        const vault = state.vaults[0];
        if (!vault || units(vault.balance, false) < units(vault.committed, false)) throw new DomainError('The vault must fully cover all unpaid commitments before any payment.', 'PRINCIPAL_SHORTFALL');
        for (const id of ids) {
          const invoice = findInvoice(state, id); invoiceAccess(actor, invoice);
          if (invoice.status !== 'committed') throw new DomainError('Only an unpaid native commitment can be settled.', 'INVALID_STATUS');
          if (Date.parse(invoice.dueAt) > Date.parse(now(state, clock()))) throw new DomainError('This commitment has not reached its chain due time.', 'NOT_DUE');
          if (findWorker(state, invoice.workerId).blocked) throw new DomainError('The native token currently restricts this recipient. The claim remains intact.', 'RECIPIENT_BLOCKED');
        }
      },
      invoke: (adapter, state) => adapter.pay(actor.organizationId, ids.map(id => findInvoice(state, id))),
      pendingInvoices: ids,
    });
  };
  app.post('/api/invoices/batch/pay', financialAccess, async (req, res) => {
    const input = z.object({ ids: z.array(text()).min(1).max(50) }).strict().parse(req.body);
    if (nativeFor(req)) await settleNative(req, res, input.ids, true); else mutate(req, res, (s, actor) => { owner(actor); payInvoices(s, actor, input.ids, clock()); });
  });
  app.post('/api/invoices/:id/approve', (req, res) => mutate(req, res, (s, actor) => approveInvoice(s, actor, String(req.params.id), clock())));
  app.post('/api/invoices/:id/commit', financialAccess, async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    if (!nativeFor(req)) { mutate(req, res, (s, actor) => commitInvoice(s, actor, String(req.params.id), clock())); return; }
    const actor = auth(req).user; owner(actor); const invoiceId = String(req.params.id);
    await nativeWrite(req, res, {
      validate: state => { const invoice = findInvoice(state, invoiceId); validateNativeCommit(state, invoice, findWorker(state, invoice.workerId)); },
      prepare: state => { const invoice = findInvoice(state, invoiceId); invoice.paymentId = nativePaymentId(actor.organizationId, invoice.id); invoice.recipient = findWorker(state, invoice.workerId).address; },
      invoke: (adapter, state) => { const invoice = findInvoice(state, invoiceId); return adapter.commit(actor.organizationId, invoice, findWorker(state, invoice.workerId)); },
      pendingInvoices: [invoiceId],
    });
  });
  app.post('/api/invoices/:id/pay', financialAccess, async (req, res) => {
    z.object({}).strict().parse(req.body ?? {}); const id = String(req.params.id);
    if (nativeFor(req)) await settleNative(req, res, [id]); else mutate(req, res, (s, actor) => payInvoices(s, actor, [id], clock()));
  });
  for (const operation of ['deposit', 'withdraw', 'allocate'] as const) app.post(`/api/vaults/:id/${operation}`, financialAccess, async (req, res) => {
    const input = z.object({ amount }).strict().parse(req.body);
    if (!nativeFor(req)) { const actions = { deposit, withdraw, allocate }; mutate(req, res, (s, actor) => actions[operation](s, actor, String(req.params.id), input.amount, clock())); return; }
    const actor = auth(req).user; owner(actor); units(input.amount);
    if (operation === 'allocate') throw new DomainError('No real strategy adapter is enabled for this native vault.', 'REAL_ACTION_UNAVAILABLE', 409);
    await nativeWrite(req, res, {
      validate: state => {
        const vault = state.vaults.find(v => v.id === String(req.params.id));
        if (!vault) throw new DomainError('Vault not found.', 'NOT_FOUND', 404);
        if (operation === 'withdraw' && units(input.amount) > units(vault.surplus, false)) throw new DomainError('Only native surplus above claims and the active buffer is withdrawable.', 'RESERVE_PROTECTED');
      },
      invoke: (adapter, _state, key) => adapter[operation](actor.organizationId, input.amount, key),
      applied: (state, result) => {
        nativePosting(state, input.amount, operation === 'deposit' ? 'liquid_vault_assets' : 'company_testnet_withdrawals', operation === 'deposit' ? 'generated_test_wallet_funding' : 'liquid_vault_assets', result.hash);
        nativeActivity(state, actor, operation === 'deposit' ? 'Native test funds deposited' : 'Native surplus withdrawn', `Verified Tempo Moderato transaction ${result.hash}. Free test assets only.`, operation, result.hash);
      },
    });
  });
  app.post('/api/vaults/:id/simulate', requireDemo, (req, res) => { const input = z.object({ event: z.enum(['loss', 'delay', 'recover']), amount: amount.optional() }).strict().parse(req.body); mutate(req, res, (s, actor) => simulateStrategy(s, actor, String(req.params.id), input.event, input.amount, clock())); });
  app.post('/api/vaults/:id/retire', financialAccess, async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    if (!nativeFor(req)) { mutate(req, res, (s, actor) => retire(s, actor, String(req.params.id), clock())); return; }
    const actor = auth(req).user; owner(actor);
    await nativeWrite(req, res, {
      validate: state => {
        const vault = state.vaults.find(v => v.id === String(req.params.id));
        if (!vault) throw new DomainError('Vault not found.', 'NOT_FOUND', 404);
        if (vault.retired) throw new DomainError('This native vault is already permanently retired.', 'VAULT_RETIRED');
        if (units(vault.committed, false) !== 0n) throw new DomainError('Settle every native commitment before retiring this vault.', 'OUTSTANDING_COMMITMENTS');
      },
      invoke: adapter => adapter.retire(actor.organizationId),
      applied: (state, result) => nativeActivity(state, actor, 'Native vault retired', `The verified Tempo transaction ${result.hash} permanently disabled new commitments and released the buffer.`, 'retirement', result.hash),
    });
  });
  app.post('/api/company', (req, res) => {
    const input = z.object({ name: text().optional(), jurisdiction: text().optional(), entityType: text().optional() }).strict().refine(v => Object.keys(v).length > 0, 'Choose at least one company field.').parse(req.body);
    mutate(req, res, (s, actor) => { owner(actor); Object.assign(s.company, input); });
  });
  app.post('/api/company/formation', (req, res) => {
    const input = z.object({ provider: z.enum(['stablecorp', 'atlas']) }).strict().parse(req.body), actor = auth(req).user; owner(actor);
    store.mutate(actor.organizationId, s => { s.company.formationProvider = input.provider; if (s.company.formationStatus === 'not_requested') s.company.formationStatus = 'handoff_requested'; });
    res.json({ url: input.provider === 'stablecorp' ? 'https://mystablecorp.xyz' : 'https://dashboard.stripe.com/atlas', statement: 'External provider handoff only. No company has been formed, verification approved, or bank account opened by Soleil. Review the provider’s eligibility, fees and service terms before submitting.' });
  });
  app.post('/api/demo/advance', requireDemo, (req, res) => { const input = z.object({ hours: z.number().positive().max(8760) }).strict().parse(req.body); mutate(req, res, (s, actor) => advanceClock(s, actor, input.hours, clock())); });
  app.post('/api/demo/reset', requireDemo, (req, res) => { const actor = auth(req).user; owner(actor); res.json(snapshot(store.resetDemo(actor, clock()), actor, clock())); });
  app.get('/api/receipts/:invoiceId', async (req, res) => { const actor = auth(req).user; invoiceAccess(actor, findInvoice(store.organization(actor.organizationId), String(req.params.invoiceId))); res.json(receipt(await readState(actor), actor, String(req.params.invoiceId))); });
  app.get('/api/exports/ledger', async (req, res) => {
    const actor = auth(req).user; owner(actor); const state = await readState(actor), label = state.mode === 'testnet' ? 'TEMPO_MODERATO_TESTNET' : 'LOCAL_SIMULATION';
    const lines = [['mode', 'created_at', 'rail', 'account', 'debit_base_units', 'credit_base_units', 'reference'].map(safeCsv).join(','), ...state.ledger.map(e => [label, e.createdAt, e.rail, e.account, e.debit, e.credit, e.reference].map(safeCsv).join(','))];
    res.setHeader('Content-Disposition', `attachment; filename="soleil-${state.mode === 'testnet' ? 'tempo-testnet' : 'local-simulation'}-ledger.csv"`); res.type('text/csv').send(lines.join('\r\n') + '\r\n');
  });
  app.use('/api', (_req, _res, next) => next(new DomainError('API endpoint not found.', 'NOT_FOUND', 404)));
  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    const directory = resolve(options.staticDirectory); app.use(express.static(directory));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(directory, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.', code: 'VALIDATION_ERROR' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON request.', code: 'INVALID_JSON' }); return; }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: 'Request exceeds the 64 KB size limit.', code: 'REQUEST_TOO_LARGE' }); return; }
    console.error('Soleil API failure:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ error: 'The request could not be completed. Refresh state before retrying with the same operation key.', code: 'INTERNAL_ERROR' });
  });
  return { app, store, close: () => store.close() };
}
