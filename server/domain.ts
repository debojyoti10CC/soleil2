import { randomUUID } from 'node:crypto';
import type { Activity, Company, Invoice, LedgerEntry, NativeStatus, Rail, Receipt, Snapshot, User, Vault, Worker } from '../src/shared/types.js';

export class DomainError extends Error {
  constructor(message: string, public code = 'INVALID_OPERATION', public status = 400) { super(message); }
}
export const SIMULATION_STATEMENT = 'Local simulation only. No blockchain funds, chain transaction, bank settlement or legal incorporation is represented by this receipt.';
const MAX_AMOUNT = (1n << 128n) - 1n;
export function units(value: unknown, positive = true): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(value)) throw new DomainError('Use an integer base-unit amount.', 'INVALID_AMOUNT');
  const n = BigInt(value);
  if (n > MAX_AMOUNT || (positive && n === 0n)) throw new DomainError('Amount is outside the supported range.', 'INVALID_AMOUNT');
  return n;
}
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function receivedTotal(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Received-total invariant');
  // The per-operation/vault bound does not limit a contractor’s lifetime sum across replenished vaults.
  return BigInt(value);
}
export interface InternalInvoice extends Invoice { recipient?: string; commitmentRef?: string; }
export interface InternalVault extends Vault { strategyDelayed: boolean; }
export interface OrganizationState {
  mode?: 'demo' | 'testnet';
  native?: NativeStatus;
  nativeNow?: string;
  nativeTokenAddress?: string;
  company: Company;
  vaults: InternalVault[];
  workers: Worker[];
  invoices: InternalInvoice[];
  activities: (Activity & { workerId?: string })[];
  ledger: LedgerEntry[];
  clockOffsetMs: number;
  demoOrganization: boolean;
  nextInvoiceNumber: number;
}
export interface PresentationBundle {
  vaultAddress: string; employerAddress: string; callerAddress: string; workerAddress: string; tokenAddress: string; depositHash: string; preparedAt: string;
}
export function nativePendingOrganization(organizationId: string, name: string): OrganizationState {
  const state = emptyOrganization(organizationId, name);
  state.mode = 'testnet'; state.company.paymentsStatus = 'testnet_only'; state.vaults = [];
  state.native = { network: 'Tempo Moderato', chainId: 42431, status: 'unavailable', executor: 'managed-test-wallet', employerAddress: '', callerAddress: '', warning: 'Provision a generated test wallet and native vault before creating claims. Free test assets only.' };
  return state;
}
export function nativeOrganization(bundle: PresentationBundle, realNow = Date.now()): OrganizationState {
  const state = emptyOrganization('presentation_tempo', 'Soleil Studio');
  state.mode = 'testnet'; state.nativeTokenAddress = bundle.tokenAddress;
  state.company.paymentsStatus = 'testnet_only';
  state.vaults = [{ id: 'native_tempo', rail: 'tempo', asset: 'pathUSD', decimals: 6, address: bundle.vaultAddress, balance: '0', committed: '0', buffer: '200000000', surplus: '0', strategyPrincipal: '0', strategyValue: '0', riskMode: 'normal', retired: false, settlementAvailable: false, strategyDelayed: false }];
  state.native = { network: 'Tempo Moderato', chainId: 42431, status: 'unavailable', executor: 'managed-test-wallet', employerAddress: bundle.employerAddress, callerAddress: bundle.callerAddress, warning: 'Native balances have not yet been verified. Refresh chain state before acting.' };
  state.workers = [{ id: 'presentation_worker', name: 'Maya Chen', email: 'presentation-worker@soleil.local', address: bundle.workerAddress, rail: 'tempo', confirmed: false, blocked: false, received: '0', managedTestWallet: true }];
  state.invoices = [{ id: 'presentation_invoice', number: 'SOL-0001', workerId: 'presentation_worker', description: 'Accepted product design milestone', amount: '300000000', dueAt: new Date(realNow - 300_000).toISOString(), rail: 'tempo', status: 'approved', createdAt: new Date(realNow).toISOString() }];
  state.nextInvoiceNumber = 2;
  return state;
}
export function simulationOnly(state: OrganizationState) {
  if (state.mode === 'testnet') throw new DomainError('This simulated operation is unavailable in the native testnet workspace.', 'REAL_ACTION_UNAVAILABLE', 409);
}
export function emptyOrganization(organizationId: string, name: string, demoOrganization = false): OrganizationState {
  return {
    company: { id: organizationId, name, jurisdiction: 'Not selected', entityType: 'Existing company', formationStatus: 'not_requested', taxIdStatus: 'not_requested', verificationStatus: 'not_started', bankingStatus: 'not_requested', paymentsStatus: 'local_simulation' },
    vaults: (['solana', 'tempo'] as const).map(rail => ({ id: id('vault'), rail, asset: 'Demo USD', decimals: 6, address: `sim_${rail}_${organizationId}`, balance: '0', committed: '0', buffer: rail === 'solana' ? '2000000000' : '1000000000', surplus: '0', strategyPrincipal: '0', strategyValue: '0', riskMode: 'normal', retired: false, settlementAvailable: false, strategyDelayed: false })),
    workers: [], invoices: [], activities: [], ledger: [], clockOffsetMs: 0, demoOrganization, nextInvoiceNumber: 1,
  };
}
export function now(state: OrganizationState, realNow = Date.now()): string { return state.mode === 'testnet' && state.nativeNow ? state.nativeNow : new Date(realNow + state.clockOffsetMs).toISOString(); }
function addActivity(state: OrganizationState, actor: User, title: string, detail: string, type: string, time: string, rail?: Rail, workerId?: string) {
  state.activities.unshift({ id: id('activity'), actor: actor.name, title, detail, type, createdAt: time, rail, workerId });
}
function posting(state: OrganizationState, rail: Rail, amount: bigint, debitAccount: string, creditAccount: string, reference: string, time: string) {
  if (amount === 0n) return;
  state.ledger.push({ id: id('entry'), createdAt: time, account: debitAccount, debit: amount.toString(), credit: '0', rail, reference }, { id: id('entry'), createdAt: time, account: creditAccount, debit: '0', credit: amount.toString(), rail, reference });
}
export function refresh(state: OrganizationState) {
  for (const v of state.vaults) {
    const l = units(v.balance, false), p = units(v.committed, false), b = units(v.buffer, false);
    const surplus = l - p - (v.retired ? 0n : b);
    v.surplus = (surplus > 0n ? surplus : 0n).toString();
    v.settlementAvailable = l >= p && (state.mode !== 'testnet' || state.native?.status === 'live');
  }
  return state;
}
export function assertState(state: OrganizationState) {
  const ids = new Set<string>();
  for (const worker of state.workers) receivedTotal(worker.received);
  for (const invoice of state.invoices) {
    units(invoice.amount);
    if (invoice.paymentId) { if (ids.has(invoice.paymentId)) throw new Error('Duplicate payment ID invariant'); ids.add(invoice.paymentId); }
    if ((invoice.status === 'committed' || invoice.status === 'paid') && (!invoice.recipient || !invoice.paymentId || !invoice.commitmentRef)) throw new Error('Missing commitment invariant');
  }
  for (const vault of state.vaults) {
    for (const amount of [vault.balance, vault.committed, vault.buffer, vault.strategyPrincipal, vault.strategyValue]) units(amount, false);
    const liability = state.invoices.filter(i => i.rail === vault.rail && i.status === 'committed').reduce((n, i) => n + units(i.amount), 0n);
    if (state.mode !== 'testnet' && liability !== units(vault.committed, false)) throw new Error('Liability invariant');
    if (vault.retired && (liability !== 0n || (state.mode !== 'testnet' && vault.buffer !== '0'))) throw new Error('Retirement invariant');
  }
  const rails = ['solana', 'tempo'] as const;
  for (const rail of rails) {
    const totals = state.ledger.filter(e => e.rail === rail).reduce((n, e) => n + units(e.debit, false) - units(e.credit, false), 0n);
    if (totals !== 0n) throw new Error('Ledger invariant');
  }
  refresh(state);
}
export function owner(actor: User) { if (actor.role !== 'owner') throw new DomainError('This action requires a company owner.', 'FORBIDDEN', 403); }
export function findWorker(state: OrganizationState, workerId: string) { const w = state.workers.find(w => w.id === workerId); if (!w) throw new DomainError('Contractor not found.', 'NOT_FOUND', 404); return w; }
export function findInvoice(state: OrganizationState, invoiceId: string) { const i = state.invoices.find(i => i.id === invoiceId); if (!i) throw new DomainError('Invoice not found.', 'NOT_FOUND', 404); return i; }
function findVault(state: OrganizationState, vaultId: string) { const v = state.vaults.find(v => v.id === vaultId); if (!v) throw new DomainError('Vault not found.', 'NOT_FOUND', 404); return v; }
function vaultFor(state: OrganizationState, rail: Rail) { const v = state.vaults.find(v => v.rail === rail); if (!v) throw new DomainError('Rail is unavailable.', 'UNSUPPORTED_RAIL'); return v; }
export function invoiceAccess(actor: User, invoice: Invoice) { if (actor.role === 'worker' && actor.workerId !== invoice.workerId) throw new DomainError('Invoice not found.', 'NOT_FOUND', 404); }
export function addWorker(state: OrganizationState, actor: User, input: { name: string; email: string; address: string; rail: Rail }, realNow?: number) {
  owner(actor);
  if (state.workers.some(w => w.email.toLowerCase() === input.email.toLowerCase())) throw new DomainError('A contractor with this email already exists.', 'DUPLICATE_WORKER', 409);
  const worker: Worker = { ...input, email: input.email.toLowerCase(), id: id('worker'), confirmed: false, blocked: false, received: '0' };
  state.workers.push(worker);
  addActivity(state, actor, 'Contractor added', `${worker.name} needs to confirm their receiving account.`, 'worker', now(state, realNow), worker.rail, worker.id);
  return worker;
}
export function confirmWorker(state: OrganizationState, actor: User, workerId: string, realNow?: number) {
  simulationOnly(state);
  const worker = findWorker(state, workerId);
  if (actor.role !== 'worker' || actor.workerId !== worker.id) throw new DomainError('Only this contractor can confirm their account.', 'FORBIDDEN', 403);
  worker.confirmed = true;
  addActivity(state, actor, 'Receiving account confirmed', 'Account confirmation is explicitly simulated locally; no wallet control proof was performed.', 'confirmation', now(state, realNow), worker.rail, worker.id);
}
export function blockWorker(state: OrganizationState, actor: User, workerId: string, blocked: boolean, realNow?: number) {
  simulationOnly(state);
  owner(actor); const worker = findWorker(state, workerId); worker.blocked = blocked;
  addActivity(state, actor, blocked ? 'Recipient restriction simulated' : 'Recipient restriction removed', 'Local transfer-eligibility simulation only. Committed principal remains reserved.', 'restriction', now(state, realNow), worker.rail, worker.id);
}
export function createInvoice(state: OrganizationState, actor: User, input: { workerId: string; description: string; amount: string; dueAt: string; rail: Rail }, realNow?: number) {
  owner(actor); units(input.amount); const worker = findWorker(state, input.workerId);
  if (worker.rail !== input.rail) throw new DomainError('Use the contractor’s confirmed receiving rail.', 'RAIL_MISMATCH');
  if (state.mode === 'testnet' && input.rail !== 'tempo') throw new DomainError('Only the provisioned native Tempo rail is currently available.', 'UNSUPPORTED_RAIL', 409);
  if (!Number.isFinite(Date.parse(input.dueAt))) throw new DomainError('Enter a valid due date.', 'INVALID_DATE');
  if (vaultFor(state, input.rail).retired) throw new DomainError('This vault has been permanently retired.', 'VAULT_RETIRED');
  const time = now(state, realNow);
  const invoice: InternalInvoice = { ...input, dueAt: new Date(input.dueAt).toISOString(), id: id('invoice'), number: `SOL-${String(state.nextInvoiceNumber++).padStart(4, '0')}`, status: 'draft', createdAt: time };
  state.invoices.push(invoice);
  addActivity(state, actor, 'Invoice created', `${invoice.number}: ${invoice.description}`, 'invoice', time, input.rail, worker.id);
  return invoice;
}
export function approveInvoice(state: OrganizationState, actor: User, invoiceId: string, realNow?: number) {
  owner(actor); const invoice = findInvoice(state, invoiceId);
  if (invoice.status !== 'draft') throw new DomainError('Only a draft invoice can be approved.', 'INVALID_STATUS');
  invoice.status = 'approved';
  addActivity(state, actor, 'Earned invoice approved', `${invoice.number} is approved, but is not yet funded or committed.`, 'approval', now(state, realNow), invoice.rail, invoice.workerId);
}
export function commitInvoice(state: OrganizationState, actor: User, invoiceId: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const invoice = findInvoice(state, invoiceId), worker = findWorker(state, invoice.workerId), vault = vaultFor(state, invoice.rail);
  if (invoice.status !== 'approved') throw new DomainError('Approve earned work before creating a commitment.', 'INVALID_STATUS');
  if (!worker.confirmed) throw new DomainError('The contractor must confirm the receiving account.', 'RECIPIENT_UNCONFIRMED');
  if (vault.retired) throw new DomainError('This vault has been permanently retired.', 'VAULT_RETIRED');
  const amount = units(invoice.amount), required = units(vault.committed, false) + amount + units(vault.buffer, false);
  if (units(vault.balance, false) < required) throw new DomainError('Fund this native vault to cover the commitment and buffer.', 'INSUFFICIENT_COVERAGE');
  const time = now(state, realNow);
  invoice.status = 'committed'; invoice.recipient = worker.address; invoice.paymentId = id('sim_payment'); invoice.commitmentRef = id('sim_commit'); invoice.transactionRef = invoice.commitmentRef;
  vault.committed = (units(vault.committed, false) + amount).toString();
  posting(state, invoice.rail, amount, 'unreserved_funds', 'committed_liabilities', invoice.paymentId, time);
  addActivity(state, actor, 'Funded commitment created', `${invoice.number} has a fixed recipient and independent local claim. This is not an on-chain commitment.`, 'commitment', time, invoice.rail, invoice.workerId);
  refresh(state);
}
function payOne(state: OrganizationState, actor: User, invoiceId: string, realNow?: number) {
  const invoice = findInvoice(state, invoiceId); invoiceAccess(actor, invoice);
  if (invoice.status !== 'committed') throw new DomainError('Only an unpaid funded commitment can be settled.', 'INVALID_STATUS');
  const vault = vaultFor(state, invoice.rail), worker = findWorker(state, invoice.workerId), time = now(state, realNow);
  if (Date.parse(invoice.dueAt) > Date.parse(time)) throw new DomainError('This commitment has not reached its due time.', 'NOT_DUE');
  if (worker.blocked) throw new DomainError('Recipient is blocked in this simulation. Principal and claim remain intact.', 'RECIPIENT_BLOCKED');
  if (units(vault.balance, false) < units(vault.committed, false)) throw new DomainError('Vault liabilities are not fully covered. No claimant is paid until funding is restored.', 'PRINCIPAL_SHORTFALL');
  const amount = units(invoice.amount);
  vault.balance = (units(vault.balance, false) - amount).toString(); vault.committed = (units(vault.committed, false) - amount).toString();
  worker.received = (receivedTotal(worker.received) + amount).toString();
  invoice.status = 'paid'; invoice.paidAt = time; invoice.transactionRef = id('sim_settle');
  posting(state, invoice.rail, amount, 'contractor_payments', 'liquid_vault_assets', invoice.transactionRef, time);
  posting(state, invoice.rail, amount, 'committed_liabilities', 'unreserved_funds', invoice.transactionRef, time);
  addActivity(state, actor, 'Committed invoice settled', `${invoice.number} was delivered to its fixed simulated recipient. No blockchain transfer occurred.`, 'settlement', time, invoice.rail, invoice.workerId);
  refresh(state);
}
export function payInvoices(state: OrganizationState, actor: User, invoiceIds: string[], realNow?: number) {
  simulationOnly(state);
  if (invoiceIds.length === 0 || invoiceIds.length > 50 || new Set(invoiceIds).size !== invoiceIds.length) throw new DomainError('Choose 1–50 distinct invoices.', 'INVALID_BATCH');
  if (invoiceIds.length > 1) owner(actor);
  // Work on a copy so a later invalid item never partly pays the earlier items, even outside the database transaction.
  const next = structuredClone(state);
  for (const invoiceId of invoiceIds) payOne(next, actor, invoiceId, realNow);
  assertState(next); Object.assign(state, next);
}
export function deposit(state: OrganizationState, actor: User, vaultId: string, amountString: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const vault = findVault(state, vaultId), amount = units(amountString), next = units(vault.balance, false) + amount; units(next.toString());
  vault.balance = next.toString(); const reference = id('sim_deposit'), time = now(state, realNow);
  posting(state, vault.rail, amount, 'liquid_vault_assets', 'simulated_external_funding', reference, time);
  addActivity(state, actor, 'Demo funds added', 'Simulated funds only. No fiat deposit or chain balance was credited.', 'deposit', time, vault.rail); refresh(state);
}
export function withdraw(state: OrganizationState, actor: User, vaultId: string, amountString: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const vault = findVault(state, vaultId), amount = units(amountString); refresh(state);
  if (amount > units(vault.surplus, false)) throw new DomainError('Only surplus above all commitments and the buffer is withdrawable.', 'RESERVE_PROTECTED');
  vault.balance = (units(vault.balance, false) - amount).toString(); const reference = id('sim_withdraw'), time = now(state, realNow);
  posting(state, vault.rail, amount, 'simulated_company_withdrawals', 'liquid_vault_assets', reference, time);
  addActivity(state, actor, 'Surplus withdrawn', 'Simulated company withdrawal; unpaid commitments and the buffer remain covered.', 'withdrawal', time, vault.rail); refresh(state);
}
export function allocate(state: OrganizationState, actor: User, vaultId: string, amountString: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const vault = findVault(state, vaultId), amount = units(amountString); refresh(state);
  if (vault.retired) throw new DomainError('A retired vault cannot make new allocations.', 'VAULT_RETIRED');
  if (vault.riskMode === 'protected') throw new DomainError('Protected mode blocks new allocations.', 'PROTECTED_MODE');
  if (amount > units(vault.surplus, false)) throw new DomainError('A strategy can use only uncommitted surplus.', 'RESERVE_PROTECTED');
  units((units(vault.strategyValue, false) + amount).toString()); units((units(vault.strategyPrincipal, false) + amount).toString());
  vault.balance = (units(vault.balance, false) - amount).toString(); vault.strategyPrincipal = (units(vault.strategyPrincipal, false) + amount).toString(); vault.strategyValue = (units(vault.strategyValue, false) + amount).toString();
  const reference = id('sim_allocate'), time = now(state, realNow);
  posting(state, vault.rail, amount, 'simulated_strategy_assets', 'liquid_vault_assets', reference, time);
  addActivity(state, actor, 'Surplus strategy simulated', 'Illustrative strategy only. Position value does not count toward liquid claim coverage.', 'strategy', time, vault.rail); refresh(state);
}
export function simulateStrategy(state: OrganizationState, actor: User, vaultId: string, event: 'loss' | 'delay' | 'recover', amountString?: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const vault = findVault(state, vaultId), time = now(state, realNow), reference = id(`sim_${event}`), value = units(vault.strategyValue, false);
  if (event === 'loss') {
    const amount = units(amountString);
    if (amount > value) throw new DomainError('Loss cannot exceed the simulated position value.', 'INVALID_LOSS');
    vault.strategyValue = (value - amount).toString(); vault.riskMode = 'protected';
    posting(state, vault.rail, amount, 'simulated_strategy_loss', 'simulated_strategy_assets', reference, time);
  } else if (event === 'delay') {
    if (value === 0n) throw new DomainError('Allocate a simulated position before delaying it.', 'NO_STRATEGY');
    vault.strategyDelayed = true; vault.riskMode = 'protected';
  } else {
    const amount = amountString === undefined ? value : units(amountString);
    if (amount > value) throw new DomainError('Recovery cannot exceed the simulated position value.', 'INVALID_RECOVERY');
    const principal = units(vault.strategyPrincipal, false);
    const costRecovered = value === 0n ? principal : (amount === value ? principal : principal * amount / value);
    units((units(vault.balance, false) + amount).toString());
    vault.balance = (units(vault.balance, false) + amount).toString(); vault.strategyValue = (value - amount).toString(); vault.strategyPrincipal = (principal - costRecovered).toString();
    vault.strategyDelayed = false; vault.riskMode = vault.strategyValue === '0' ? 'normal' : 'protected';
    posting(state, vault.rail, amount, 'liquid_vault_assets', 'simulated_strategy_assets', reference, time);
  }
  addActivity(state, actor, `Strategy ${event} simulated`, 'Local scenario only. Covered committed payments remain independent of strategy recovery.', 'strategy', time, vault.rail); refresh(state);
}
export function retire(state: OrganizationState, actor: User, vaultId: string, realNow?: number) {
  simulationOnly(state);
  owner(actor); const vault = findVault(state, vaultId);
  if (units(vault.committed, false) !== 0n) throw new DomainError('Settle every commitment before retiring this vault.', 'OUTSTANDING_COMMITMENTS');
  if (vault.retired) throw new DomainError('This vault is already permanently retired.', 'VAULT_RETIRED');
  vault.retired = true; vault.buffer = '0';
  addActivity(state, actor, 'Vault permanently retired', 'New commitments and allocations are disabled. The company buffer is released; existing strategy recovery remains available.', 'retirement', now(state, realNow), vault.rail); refresh(state);
}
export function snapshot(state: OrganizationState, actor: User, realNow?: number): Snapshot {
  refresh(state);
  const worker = actor.role === 'worker';
  return { user: actor, company: { ...state.company }, vaults: state.vaults.map(({ strategyDelayed: _hidden, ...v }) => ({ ...v })), workers: state.workers.filter(w => !worker || w.id === actor.workerId).map(w => ({ ...w })), invoices: state.invoices.filter(i => !worker || i.workerId === actor.workerId).map(({ recipient: _recipient, commitmentRef: _commitment, ...i }) => ({ ...i })), activities: state.activities.filter(a => !worker || a.workerId === actor.workerId).map(({ workerId: _hidden, ...a }) => ({ ...a })), now: now(state, realNow), mode: state.mode ?? 'demo', ...(state.native ? { native: { ...state.native } } : {}) };
}
export function receipt(state: OrganizationState, actor: User, invoiceId: string): Receipt {
  const invoice = findInvoice(state, invoiceId); invoiceAccess(actor, invoice);
  if (state.mode === 'testnet' && invoice.status === 'paid' && !invoice.transactionRef) throw new DomainError('The paid claim is verified; its settlement transaction is still being indexed. Refresh before exporting a receipt.', 'CHAIN_RECEIPT_UNAVAILABLE', 409);
  if (!invoice.paymentId || !invoice.recipient || !invoice.transactionRef) throw new DomainError('A receipt is available after funded commitment.', 'NOT_COMMITTED');
  const vault = vaultFor(state, invoice.rail);
  if (state.mode === 'testnet') {
    if (!/^0x[a-fA-F0-9]{64}$/.test(invoice.paymentId) || !/^0x[a-fA-F0-9]{64}$/.test(invoice.transactionRef)) throw new DomainError('A verified native transaction is not yet available for this invoice.', 'CHAIN_RECEIPT_UNAVAILABLE', 409);
    return { version: '2', mode: 'testnet', invoiceId: invoice.id, paymentId: invoice.paymentId, rail: 'tempo', asset: vault.asset, amount: invoice.amount, decimals: vault.decimals, recipient: invoice.recipient, vault: vault.address, dueAt: invoice.dueAt, status: invoice.status, transactionRef: invoice.transactionRef, commitTransactionRef: invoice.commitTransactionRef, statement: `Actual Tempo Moderato testnet claim, using free test assets and server-controlled generated test wallets. No bank settlement or company formation is implied.${state.native?.status !== 'live' ? ' Current chain refresh is unavailable; this receipt reflects the last verified state.' : ''}`, chainId: 42431, tokenAddress: state.nativeTokenAddress, explorerUrl: `https://explore.testnet.tempo.xyz/tx/${invoice.transactionRef}`, checkedAt: state.native?.checkedAt };
  }
  return { version: '1', mode: 'demo', invoiceId: invoice.id, paymentId: invoice.paymentId, rail: invoice.rail, asset: vault.asset, amount: invoice.amount, decimals: vault.decimals, recipient: invoice.recipient, vault: vault.address, dueAt: invoice.dueAt, status: invoice.status, transactionRef: invoice.transactionRef, statement: SIMULATION_STATEMENT };
}
export function advanceClock(state: OrganizationState, actor: User, hours: number, realNow?: number) {
  simulationOnly(state);
  owner(actor);
  if (!state.demoOrganization) throw new DomainError('Clock travel is available only in the seeded demo company.', 'DEMO_ONLY', 403);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760 || state.clockOffsetMs + hours * 3_600_000 > 10 * 365 * 24 * 3_600_000) throw new DomainError('Advance by a positive number of hours, at most one year at a time.', 'INVALID_CLOCK');
  state.clockOffsetMs += Math.round(hours * 3_600_000);
  addActivity(state, actor, 'Demo clock advanced', `Local demonstration clock advanced by ${hours} hours. Real chain timestamps are unchanged.`, 'clock', now(state, realNow));
}
export function seedOrganization(organizationId: string, actor: User, realNow = Date.now()): OrganizationState {
  const state = emptyOrganization(organizationId, 'Soleil Studio', true);
  state.company.jurisdiction = 'Local demonstration'; state.company.entityType = 'Simulated existing company';
  const worker = addWorker(state, actor, { name: 'Maya Chen', email: 'worker@soleil.local', address: 'sim_recipient_maya_solana', rail: 'solana' }, realNow);
  worker.id = 'demo_worker_maya'; worker.confirmed = false;
  const second = addWorker(state, actor, { name: 'Alex Rivera', email: 'alex@soleil.local', address: 'sim_recipient_alex_tempo', rail: 'tempo' }, realNow); second.confirmed = true;
  const third = addWorker(state, actor, { name: 'Sam Patel', email: 'sam@soleil.local', address: 'sim_recipient_sam_solana', rail: 'solana' }, realNow); third.confirmed = true;
  deposit(state, actor, state.vaults[0]!.id, '20000000000', realNow); deposit(state, actor, state.vaults[1]!.id, '12000000000', realNow);
  const due = new Date(realNow + 48 * 3_600_000).toISOString();
  createInvoice(state, actor, { workerId: worker.id, description: 'Brand design — accepted milestone', amount: '2400000000', dueAt: due, rail: 'solana' }, realNow);
  const ready = createInvoice(state, actor, { workerId: third.id, description: 'Product engineering — accepted sprint', amount: '4200000000', dueAt: due, rail: 'solana' }, realNow); approveInvoice(state, actor, ready.id, realNow); commitInvoice(state, actor, ready.id, realNow);
  const mature = createInvoice(state, actor, { workerId: second.id, description: 'Content system — accepted delivery', amount: '1800000000', dueAt: new Date(realNow - 3_600_000).toISOString(), rail: 'tempo' }, realNow); approveInvoice(state, actor, mature.id, realNow); commitInvoice(state, actor, mature.id, realNow);
  const own = createInvoice(state, actor, { workerId: worker.id, description: 'Research report — awaiting review', amount: '850000000', dueAt: due, rail: 'solana' }, realNow); approveInvoice(state, actor, own.id, realNow);
  assertState(state); return state;
}
