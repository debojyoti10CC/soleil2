import { randomUUID } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import type { Invoice, NativeStatus, User, Vault, Worker } from '../src/shared/types.js';
import { DomainError, now, refresh, units, type InternalInvoice, type OrganizationState, type PresentationBundle } from './domain.js';
import { Store } from './store.js';

export interface NativeTxResult { hash: string; blockNumber: string; }
export interface NativeView { vault: Vault; invoices: Invoice[]; workers: Worker[]; native: NativeStatus; now: string; }
/** Only generated, isolated Tempo Moderato test keys are allowed behind this interface. */
export interface NativeWorkspaceAdapter {
  provision(organizationId: string): Promise<PresentationBundle>;
  cachedBundle(organizationId: string): PresentationBundle | null;
  sync(organizationId: string, invoices: Invoice[], workers: Worker[]): Promise<NativeView>;
  commit(organizationId: string, invoice: Invoice, worker: Worker): Promise<NativeTxResult>;
  pay(organizationId: string, invoices: Invoice[]): Promise<NativeTxResult>;
  deposit(organizationId: string, amount: string, operationKey: string): Promise<NativeTxResult>;
  withdraw(organizationId: string, amount: string, operationKey: string): Promise<NativeTxResult>;
  retire(organizationId: string): Promise<NativeTxResult>;
  managedWorker(organizationId: string, workerId: string): Promise<string>;
  confirmManagedWorker(organizationId: string, worker: Worker): Promise<{ signature: string; address: string; message: string }>;
}
export const nativePaymentId = (organizationId: string, invoiceId: string) => keccak256(toHex(`soleil:tempo:${organizationId}:${invoiceId}`));
const isHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function applyNativeBundle(state: OrganizationState, bundle: PresentationBundle) {
  if (![bundle.vaultAddress, bundle.tokenAddress, bundle.employerAddress, bundle.callerAddress].every(isAddress)) throw new DomainError('The native vault bundle is invalid.', 'NATIVE_CONFIGURATION', 503);
  const current = state.vaults[0];
  if (current && !sameAddress(current.address, bundle.vaultAddress)) throw new DomainError('The persisted native vault does not match its generated wallet bundle.', 'NATIVE_CONFIGURATION', 503);
  state.mode = 'testnet'; state.nativeTokenAddress = bundle.tokenAddress; state.company.paymentsStatus = 'testnet_only';
  if (!current) state.vaults = [{ id: 'native_tempo', rail: 'tempo', asset: 'pathUSD', decimals: 6, address: bundle.vaultAddress, balance: '0', committed: '0', buffer: '200000000', surplus: '0', strategyPrincipal: '0', strategyValue: '0', riskMode: 'normal', retired: false, settlementAvailable: false, strategyDelayed: false }];
  state.native = { ...state.native, network: 'Tempo Moderato', chainId: 42431, status: state.native?.status ?? 'unavailable', executor: 'managed-test-wallet', employerAddress: bundle.employerAddress, callerAddress: bundle.callerAddress };
}
export function nativePosting(state: OrganizationState, amount: string, debitAccount: string, creditAccount: string, reference: string, time = now(state)) {
  units(amount);
  if (state.ledger.some(e => e.reference === reference && e.account === debitAccount && e.debit === amount)) return;
  state.ledger.push({ id: `entry_${randomUUID()}`, createdAt: time, account: debitAccount, debit: amount, credit: '0', rail: 'tempo', reference }, { id: `entry_${randomUUID()}`, createdAt: time, account: creditAccount, debit: '0', credit: amount, rail: 'tempo', reference });
}
export function nativeActivity(state: OrganizationState, actor: User, title: string, detail: string, type: string, reference: string, workerId?: string) {
  const id = `native_${type}_${reference}`;
  if (state.activities.some(a => a.id === id)) return;
  state.activities.unshift({ id, actor: actor.name, title, detail, type, createdAt: now(state), rail: 'tempo', workerId });
}

/** Merge verified chain fields into the latest metadata; never replace a pre-RPC JSON snapshot. */
export function mergeNativeView(state: OrganizationState, view: NativeView, cached = false) {
  const vault = state.vaults[0];
  if (!vault || view.native.chainId !== 42431 || view.native.executor !== 'managed-test-wallet' || !sameAddress(vault.address, view.vault.address) || view.vault.rail !== 'tempo' || view.vault.asset !== 'pathUSD' || view.vault.decimals !== 6 || (view.native.status !== 'live' && !(cached && view.native.status === 'stale')) || !view.native.checkedAt || !Number.isFinite(Date.parse(view.native.checkedAt)) || !state.native || !sameAddress(state.native.employerAddress, view.native.employerAddress) || !sameAddress(state.native.callerAddress, view.native.callerAddress)) throw new DomainError('The native read did not verify the configured Tempo vault.', 'NATIVE_CONFIGURATION', 503);
  if (!view.native.blockNumber || !/^\d+$/.test(view.native.blockNumber) || !Number.isFinite(Date.parse(view.now))) throw new DomainError('The native read is missing a verified block and timestamp.', 'NATIVE_CONFIGURATION', 503);
  if (state.native?.blockNumber && BigInt(view.native.blockNumber) < BigInt(state.native.blockNumber)) throw new DomainError('The RPC endpoint returned an older block. Writes remain disabled until fresh verification.', 'NATIVE_STALE', 503);
  const verifiedVault = view.vault;
  for (const value of [verifiedVault.balance, verifiedVault.committed, verifiedVault.buffer, verifiedVault.strategyPrincipal, verifiedVault.strategyValue]) units(value, false);
  Object.assign(vault, { balance: verifiedVault.balance, committed: verifiedVault.committed, buffer: verifiedVault.buffer, strategyPrincipal: verifiedVault.strategyPrincipal, strategyValue: verifiedVault.strategyValue, riskMode: verifiedVault.riskMode, retired: verifiedVault.retired, settlementAvailable: verifiedVault.settlementAvailable, strategyDelayed: false });
  state.native = { ...view.native }; state.nativeNow = view.now;
  for (const remote of view.workers) {
    const worker = state.workers.find(w => w.id === remote.id);
    if (!worker) continue;
    if (!sameAddress(worker.address, remote.address) || remote.rail !== 'tempo' || !/^(0|[1-9]\d*)$/.test(remote.received)) throw new DomainError('A native receiving-account mapping is inconsistent.', 'NATIVE_CONFIGURATION', 503);
    worker.received = remote.received; worker.blocked = remote.blocked;
  }
  for (const remote of view.invoices) {
    const invoice = state.invoices.find(i => i.id === remote.id);
    if (!invoice) continue;
    if (remote.nativePending) invoice.nativePending = { ...remote.nativePending }; else if (!cached) delete invoice.nativePending;
    // Draft/approval and edits are local metadata. Chain tuples govern committed and paid states.
    if (remote.status !== 'committed' && remote.status !== 'paid') continue;
    if (remote.paymentId !== nativePaymentId(state.company.id, invoice.id) || remote.amount !== invoice.amount || remote.workerId !== invoice.workerId || remote.rail !== 'tempo' || Date.parse(remote.dueAt) !== Date.parse(invoice.dueAt)) throw new DomainError('A native commitment differs from its immutable invoice mapping.', 'NATIVE_CONFIGURATION', 503);
    if (invoice.status === 'paid' && remote.status !== 'paid') throw new DomainError('The native read would reverse an already verified payment.', 'NATIVE_STALE', 503);
    const previouslyPaid = invoice.status === 'paid';
    const previousSettlementHash = previouslyPaid ? invoice.transactionRef : undefined;
    const worker = state.workers.find(w => w.id === invoice.workerId);
    if (!worker) throw new DomainError('The native recipient mapping is unavailable.', 'NATIVE_CONFIGURATION', 503);
    invoice.recipient ??= worker.address;
    if (!sameAddress(invoice.recipient, worker.address)) throw new DomainError('The native recipient mapping changed after commitment.', 'NATIVE_CONFIGURATION', 503);
    invoice.paymentId = remote.paymentId; invoice.commitmentRef = isHash(remote.commitTransactionRef) ? remote.commitTransactionRef : remote.paymentId;
    invoice.status = remote.status;
    if (isHash(remote.commitTransactionRef)) invoice.commitTransactionRef = remote.commitTransactionRef;
    if (remote.status === 'paid') {
      // An indexed settlement hash may be unavailable. Never present a commit hash as the payment.
      invoice.transactionRef = isHash(remote.transactionRef) && remote.transactionRef !== invoice.commitTransactionRef ? remote.transactionRef : previousSettlementHash;
      invoice.paidAt = remote.paidAt ?? view.now;
    } else invoice.transactionRef = isHash(remote.transactionRef) ? remote.transactionRef : invoice.commitTransactionRef;
    if (remote.nativePending) invoice.nativePending = { ...remote.nativePending }; else if (!cached) delete invoice.nativePending;
    nativePosting(state, invoice.amount, 'unreserved_funds', 'committed_liabilities', invoice.paymentId, view.now);
    const observer: User = { id: 'chain_observer', name: 'Verified Tempo chain', email: '', role: 'owner', organizationId: state.company.id };
    nativeActivity(state, observer, 'Native funded commitment verified', `${invoice.number} has a fixed Tempo testnet recipient and amount.`, 'commitment', invoice.paymentId, invoice.workerId);
    if (invoice.status === 'paid' && invoice.transactionRef) {
      const reference = `${invoice.transactionRef}:${invoice.paymentId}`;
      nativePosting(state, invoice.amount, 'contractor_payments', 'liquid_vault_assets', reference, view.now);
      nativePosting(state, invoice.amount, 'committed_liabilities', 'unreserved_funds', reference, view.now);
      nativeActivity(state, observer, 'Native payment verified', `${invoice.number} was transferred to its fixed Tempo testnet recipient.`, 'settlement', reference, invoice.workerId);
    }
  }
  refresh(state);
}

export class NativeWorkspaceCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly adapter: NativeWorkspaceAdapter, readonly clock: () => number) {}
  async exclusive<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(organizationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(organizationId, current);
    try { return await current; } finally { if (this.queues.get(organizationId) === current) this.queues.delete(organizationId); }
  }
  private stale(organizationId: string, warning = 'Chain refresh is unavailable. Showing the last verified state; native writes are disabled.') {
    return this.store.mutate(organizationId, state => {
      if (state.native) state.native = { ...state.native, status: state.native.checkedAt ? 'stale' : 'unavailable', warning };
    }).state;
  }
  async refresh(organizationId: string): Promise<OrganizationState> {
    const before = this.store.organization(organizationId);
    if (before.mode !== 'testnet') return before;
    if (!this.adapter.cachedBundle(organizationId)) return this.stale(organizationId, 'The native test vault has not been provisioned. No simulated funds are shown.');
    try {
      const view = await this.adapter.sync(organizationId, before.invoices, before.workers);
      return this.store.mutate(organizationId, state => mergeNativeView(state, view, view.native.status === 'stale')).state;
    } catch (error) { return this.stale(organizationId, error instanceof DomainError ? `${error.message} Showing the last verified state; native writes are disabled.` : undefined); }
  }
  async read(organizationId: string) { return this.exclusive(organizationId, () => this.refresh(organizationId)); }
  async write(actor: User, key: string, fingerprint: string, callbacks: {
    validate: (state: OrganizationState) => void;
    prepare?: (state: OrganizationState) => void;
    invoke: (adapter: NativeWorkspaceAdapter, state: OrganizationState, journalKey: string) => Promise<NativeTxResult>;
    applied?: (state: OrganizationState, result: NativeTxResult) => void;
    pendingInvoices?: string[];
  }): Promise<OrganizationState> {
    return this.exclusive(actor.organizationId, async () => {
      const previous = this.store.nativeOperation(actor.id, key, fingerprint);
      if (previous?.complete) return this.refresh(actor.organizationId);
      const verified = await this.refresh(actor.organizationId);
      if (verified.native?.status !== 'live') throw new DomainError('Native writes require a fresh verified Tempo vault. Refresh and retry the same operation.', 'NATIVE_UNAVAILABLE', 503);
      if (!previous) callbacks.validate(verified);
      if (callbacks.prepare && !previous) this.store.mutate(actor.organizationId, callbacks.prepare);
      this.store.beginNativeOperation(actor.id, key, fingerprint);
      let result: NativeTxResult;
      try {
        result = await callbacks.invoke(this.adapter, this.store.organization(actor.organizationId), `${actor.id}:${key}`);
        if (!isHash(result.hash) || !/^\d+$/.test(result.blockNumber)) throw new Error('Unverified native transaction result');
      } catch (error) {
        if (error instanceof DomainError && error.code !== 'NATIVE_PENDING') {
          this.store.mutate(actor.organizationId, state => { for (const id of callbacks.pendingInvoices ?? []) { const invoice = state.invoices.find(i => i.id === id); if (invoice) delete invoice.nativePending; } });
          throw error;
        }
        const hash = error instanceof DomainError ? error.message.match(/0x[0-9a-fA-F]{64}/)?.[0] : undefined;
        this.store.mutate(actor.organizationId, state => {
          for (const id of callbacks.pendingInvoices ?? []) { const invoice = state.invoices.find(i => i.id === id); if (invoice) invoice.nativePending = { operation: 'native-transaction', hash, status: 'uncertain' }; }
        });
        this.stale(actor.organizationId, 'The transaction outcome needs reconciliation. Refresh and retry the same operation key; do not start a replacement transaction.');
        throw new DomainError(`The native transaction outcome could not be verified. Refresh and retry with the same operation key.${hash ? ` Saved transaction: ${hash}` : ''}`, error instanceof DomainError ? error.code : 'NATIVE_OUTCOME_UNKNOWN', 503);
      }
      this.store.mutate(actor.organizationId, state => {
        this.store.completeNativeOperation(actor.id, key, result);
        for (const id of callbacks.pendingInvoices ?? []) { const invoice = state.invoices.find(i => i.id === id); if (invoice) invoice.nativePending = { operation: 'native-transaction', hash: result.hash, status: 'submitted' }; }
        callbacks.applied?.(state, result);
      });
      return this.refresh(actor.organizationId);
    });
  }
}

export function validateNativeCommit(state: OrganizationState, invoice: InternalInvoice, worker: Worker) {
  if (invoice.status !== 'approved') throw new DomainError('Approve earned work before creating a commitment.', 'INVALID_STATUS');
  if (invoice.rail !== 'tempo' || worker.rail !== 'tempo') throw new DomainError('Only the provisioned native Tempo rail is available.', 'UNSUPPORTED_RAIL', 409);
  if (!worker.confirmed || !worker.managedTestWallet || !worker.confirmationProof) throw new DomainError('The contractor must acknowledge the generated test receiving wallet.', 'RECIPIENT_UNCONFIRMED');
  const vault = state.vaults[0];
  if (!vault || vault.retired) throw new DomainError('This vault is unavailable or permanently retired.', 'VAULT_RETIRED');
  if (units(vault.balance, false) < units(vault.committed, false) + units(invoice.amount) + units(vault.buffer, false)) throw new DomainError('Fund the native vault to cover this claim and its buffer.', 'INSUFFICIENT_COVERAGE');
}
