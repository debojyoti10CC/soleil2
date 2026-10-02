import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from 'viem/tempo';
import { tempoModerato } from 'viem/chains';
import { encodeDeployData, encodeFunctionData, http, keccak256, toHex, parseAbi, parseAbiItem, verifyMessage, zeroAddress, type Address, type Hex, type Abi } from 'viem';
import type { Invoice, Worker, Vault, NativeStatus } from '../src/shared/types.js';
import { DomainError, units } from './domain.js';
import { TestnetKeystore } from './native-keystore.js';
import { NativeJournal, type NativeOperation } from './native-journal.js';
import { matchesVaultRuntime } from '../src/lib/verify-runtime.js';

const RPC = 'https://rpc.moderato.tempo.xyz';
const TOKEN = '0x20c0000000000000000000000000000000000000' as Address;
const BUFFER = 200_000_000n;
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function decimals() view returns(uint8)']);
export interface NativeBundle { vaultAddress: string; employerAddress: string; callerAddress: string; workerAddress: string; tokenAddress: string; depositHash: string; preparedAt: string; deploymentHash: string; deploymentBlock: string; }
export interface NativeTxResult { hash: string; blockNumber: string; }
export interface NativeView { vault: Vault; invoices: Invoice[]; workers: Worker[]; native: NativeStatus; now: string; }
interface Artifact { abi: Abi; bytecode: Hex; deployedBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]>; }
export function nativePaymentId(orgId: string, invoiceId: string) { return keccak256(toHex(`soleil:tempo:${orgId}:${invoiceId}`)); }

/** A fixed testnet executor. Keys are generated here, encrypted at rest, and never imported/exported. */
export class NativeTempoWorkspace {
  private readonly keys: TestnetKeystore;
  private readonly journal: NativeJournal;
  private readonly artifact: Artifact;
  private readonly reader;
  private readonly preparing = new Map<string, Promise<NativeBundle>>();
  constructor(options: { directory: string; artifactPath?: string }) {
    this.keys = new TestnetKeystore(resolve(options.directory, 'wallets'));
    this.journal = new NativeJournal(resolve(options.directory, 'operations.sqlite'));
    this.artifact = JSON.parse(readFileSync(options.artifactPath ?? resolve('public/contracts/SoleilVault.json'), 'utf8')) as Artifact;
    this.reader = createClient({ chain: tempoModerato, transport: http(RPC, { timeout: 10_000, retryCount: 0 }) });
  }
  close() { this.journal.close(); }
  cachedBundle(orgId: string) { return this.journal.get<NativeBundle>(`bundle:${orgId}`); }
  private wallet(orgId: string, role: string) {
    return createClient({ account: this.keys.account(`${orgId}:${role}`), chain: tempoModerato, feeToken: TOKEN, transport: http(RPC, { timeout: 10_000, retryCount: 0 }) });
  }
  private requireBundle(orgId: string) { const bundle = this.cachedBundle(orgId); if (!bundle) throw new DomainError('Prepare the native testnet vault before presenting.', 'NATIVE_NOT_READY', 503); return bundle; }
  private async network() {
    const [chainId, decimals] = await Promise.all([this.reader.getChainId(), this.reader.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'decimals' })]);
    if (chainId !== 42431) throw new DomainError('The RPC is not Tempo Moderato. Operation refused.', 'WRONG_NETWORK', 503);
    if (decimals !== 6) throw new DomainError('Unexpected test asset.', 'WRONG_ASSET', 503);
  }
  private async verify(bundle: NativeBundle, blockNumber?: bigint) {
    await this.network();
    const address = bundle.vaultAddress as Address;
    const [code, token, employer, strategy] = await Promise.all([
      this.reader.getCode({ address, blockNumber }),
      this.reader.readContract({ address, abi: this.artifact.abi, functionName: 'token', blockNumber }),
      this.reader.readContract({ address, abi: this.artifact.abi, functionName: 'employer', blockNumber }),
      this.reader.readContract({ address, abi: this.artifact.abi, functionName: 'strategy', blockNumber }),
    ]);
    if (!code || !matchesVaultRuntime(code, this.artifact) || String(token).toLowerCase() !== TOKEN.toLowerCase() || String(employer).toLowerCase() !== bundle.employerAddress.toLowerCase() || String(strategy).toLowerCase() !== zeroAddress) throw new DomainError('Native vault identity does not match the verified Soleil contract.', 'VAULT_MISMATCH', 503);
  }
  private async confirmed(operation: NativeOperation): Promise<NativeTxResult> {
    if (!operation.hash || !operation.raw) throw new Error('A signed native operation is missing its durable transaction.');
    if (operation.state === 'confirmed') return { hash: operation.hash, blockNumber: operation.blockNumber! };
    if (operation.state === 'reverted') throw new DomainError(`Native transaction reverted: ${operation.hash}`, 'NATIVE_REVERTED', 409);
    let receipt;
    try { receipt = await this.reader.getTransactionReceipt({ hash: operation.hash as Hex }); } catch { /* It may not have been broadcast before restart. */ }
    if (!receipt) {
      try {
        const returned = await this.reader.sendRawTransaction({ serializedTransaction: operation.raw as Hex });
        if (returned.toLowerCase() !== operation.hash.toLowerCase()) throw new Error('RPC returned a different transaction hash.');
      } catch { /* A duplicate broadcast or an interrupted response may still have succeeded. Reconcile by hash. */ }
      try { receipt = await this.reader.waitForTransactionReceipt({ hash: operation.hash as Hex, timeout: 25_000, pollingInterval: 1500 }); }
      catch { throw new DomainError(`Tempo confirmation is pending. Refresh or retry this operation; its saved transaction will be reconciled: ${operation.hash}`, 'NATIVE_PENDING', 503); }
    }
    this.journal.settled(operation.key, receipt.status === 'success', receipt.blockNumber.toString());
    if (receipt.status !== 'success') throw new DomainError(`Native transaction reverted: ${operation.hash}`, 'NATIVE_REVERTED', 409);
    return { hash: operation.hash, blockNumber: receipt.blockNumber.toString() };
  }
  private async send(orgId: string, role: string, key: string, to: Address | undefined, data: Hex) {
    const wallet = this.wallet(orgId, role), address = wallet.account.address, owner = randomUUID();
    const fingerprint = keccak256(toHex(JSON.stringify({ orgId, address, to, data, chainId: 42431 })));
    const previous = this.journal.operation(key);
    if (previous && previous.fingerprint !== fingerprint) throw new DomainError('This operation key was already used for a different transaction.', 'IDEMPOTENCY_CONFLICT', 409);
    if (!this.journal.lock(address, owner)) throw new DomainError('Another transaction is being reconciled. Refresh and retry shortly.', 'NATIVE_BUSY', 409);
    const lease = setInterval(() => this.journal.renew(address, owner), 30_000); lease.unref();
    try {
      if (previous?.state === 'reverted') this.journal.retryReverted(key);
      else if (previous && previous.state !== 'intent') return await this.confirmed(previous);
      for (const pending of this.journal.pending(address)) await this.confirmed(pending);
      this.journal.intent({ key, orgId, fingerprint, wallet: address, state: 'intent' });
      await this.network();
      let raw: Hex;
      try { const prepared = await wallet.prepareTransactionRequest({ to, data }); raw = await wallet.signTransaction(prepared); }
      catch { throw new DomainError('Tempo could not prepare this transaction. No signed transaction was broadcast. Verify the amount, due time, recipient and funding, then retry.', 'NATIVE_REJECTED', 409); }
      const hash = keccak256(raw);
      this.journal.signed(key, hash, raw);
      return await this.confirmed(this.journal.operation(key)!);
    } finally { clearInterval(lease); this.journal.unlock(address, owner); }
  }
  private call(orgId: string, role: string, key: string, address: Address, functionName: string, args: readonly unknown[] = []) {
    return this.send(orgId, role, key, address, encodeFunctionData({ abi: this.artifact.abi, functionName, args }));
  }
  async provision(orgId: string): Promise<NativeBundle> {
    const ready = this.cachedBundle(orgId); if (ready) { await this.verify(ready); return ready; }
    const inFlight = this.preparing.get(orgId); if (inFlight) return inFlight;
    const promise = this.prepare(orgId); this.preparing.set(orgId, promise);
    try { return await promise; } finally { this.preparing.delete(orgId); }
  }
  private async prepare(orgId: string) {
    await this.network();
    const employer = this.wallet(orgId, 'employer'), caller = this.wallet(orgId, 'caller'), worker = this.wallet(orgId, 'worker:presentation_worker');
    for (const [role, wallet] of [['employer', employer], ['caller', caller]] as const) {
      const balance = await this.reader.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.account.address] }) as bigint;
      if (balance < 100_000_000n && !this.journal.get(`faucet:${orgId}:${role}`)) {
        await wallet.faucet.fundSync({ account: wallet.account.address });
        this.journal.set(`faucet:${orgId}:${role}`, { at: new Date().toISOString() });
      }
    }
    const deployed = await this.send(orgId, 'employer', `deploy:${orgId}`, undefined, encodeDeployData({ abi: this.artifact.abi, bytecode: this.artifact.bytecode, args: [TOKEN, employer.account.address, BUFFER, zeroAddress] }));
    const receipt = await this.reader.getTransactionReceipt({ hash: deployed.hash as Hex });
    if (!receipt.contractAddress) throw new Error('Native deployment did not return a vault address.');
    const vault = receipt.contractAddress;
    const existingFunding = this.journal.get<string>(`initial-funding:${orgId}`);
    let funding: bigint;
    if (existingFunding) funding = BigInt(existingFunding);
    else {
      const balance = await this.reader.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [employer.account.address] }) as bigint;
      // Faucet is setup only. A resumed confirmed deposit must not depend on the remaining wallet balance.
      funding = balance > 20_100_000_000n ? 20_000_000_000n : balance - 100_000_000n;
      if (funding < 1_000_000_000n) throw new DomainError('Free test funds are insufficient for presentation setup.', 'TEST_FUNDING_REQUIRED', 503);
      this.journal.set(`initial-funding:${orgId}`, funding.toString());
    }
    await this.send(orgId, 'employer', `approve-initial:${orgId}`, TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [vault, funding] }));
    const deposited = await this.call(orgId, 'employer', `deposit-initial:${orgId}`, vault, 'deposit', [funding]);
    const bundle: NativeBundle = { vaultAddress: vault, employerAddress: employer.account.address, callerAddress: caller.account.address, workerAddress: worker.account.address, tokenAddress: TOKEN, depositHash: deposited.hash, deploymentHash: deployed.hash, deploymentBlock: deployed.blockNumber, preparedAt: new Date().toISOString() };
    await this.verify(bundle); this.journal.set(`bundle:${orgId}`, bundle); return bundle;
  }
  async managedWorker(orgId: string, workerId: string) { return this.wallet(orgId, `worker:${workerId}`).account.address; }
  async confirmManagedWorker(orgId: string, worker: Worker) {
    const label = `${orgId}:worker:${worker.id}`;
    if (!worker.managedTestWallet || !this.keys.has(label)) throw new DomainError('This worker has no assigned managed test wallet.', 'WALLET_NOT_MANAGED', 409);
    const account = this.keys.account(label);
    if (account.address.toLowerCase() !== worker.address.toLowerCase()) throw new DomainError('The assigned managed wallet does not match this recipient.', 'RECIPIENT_MISMATCH', 409);
    const message = `Soleil managed TESTNET recipient confirmation\nChain: Tempo Moderato 42431\nOrganization: ${orgId}\nWorker: ${worker.id}\nAddress: ${account.address}\nThis key is held by the local Soleil server; this is not proof of a user's external wallet ownership.`;
    const signature = await account.signMessage({ message });
    if (!await verifyMessage({ address: account.address, message, signature })) throw new Error('Managed test wallet signature verification failed.');
    return { signature, address: account.address, message };
  }
  private async claim(bundle: NativeBundle, orgId: string, invoice: Invoice, blockNumber?: bigint) {
    const paymentId = nativePaymentId(orgId, invoice.id);
    if (invoice.paymentId && invoice.paymentId !== paymentId) throw new DomainError('Unexpected native payment ID.', 'CLAIM_MISMATCH', 409);
    return await this.reader.readContract({ address: bundle.vaultAddress as Address, abi: this.artifact.abi, functionName: 'claims', args: [paymentId], blockNumber }) as [Address, bigint, bigint, boolean];
  }
  private checkClaim(claim: [Address, bigint, bigint, boolean], invoice: Invoice, address: string) {
    if (claim[0].toLowerCase() !== address.toLowerCase() || claim[1] !== units(invoice.amount) || claim[2] !== BigInt(Math.floor(Date.parse(invoice.dueAt) / 1000))) throw new DomainError('The immutable native claim differs from this invoice. Payment refused.', 'CLAIM_MISMATCH', 409);
  }
  async commit(orgId: string, invoice: Invoice, worker: Worker) {
    const bundle = this.requireBundle(orgId); await this.verify(bundle);
    if (!worker.confirmed || !worker.managedTestWallet || worker.rail !== 'tempo') throw new DomainError('Confirm the assigned Tempo test recipient first.', 'RECIPIENT_UNCONFIRMED', 409);
    const claim = await this.claim(bundle, orgId, invoice);
    if (claim[0] !== zeroAddress) {
      this.checkClaim(claim, invoice, worker.address);
      const operation = this.journal.operation(`commit:${orgId}:${invoice.id}`);
      if (operation?.hash) return this.confirmed(operation);
      throw new DomainError('Claim exists on chain; refresh to reconcile its event.', 'CLAIM_EXISTS', 409);
    }
    if (invoice.status !== 'approved') throw new DomainError('Approve earned work before committing.', 'INVALID_STATUS');
    return this.call(orgId, 'employer', `commit:${orgId}:${invoice.id}`, bundle.vaultAddress as Address, 'commit', [nativePaymentId(orgId, invoice.id), worker.address, units(invoice.amount), BigInt(Math.floor(Date.parse(invoice.dueAt) / 1000))]);
  }
  async pay(orgId: string, invoices: Invoice[]) {
    const bundle = this.requireBundle(orgId); await this.verify(bundle);
    if (!invoices.length || invoices.length > 32 || new Set(invoices.map(i => i.id)).size !== invoices.length) throw new DomainError('Select 1–32 distinct native invoices.', 'INVALID_BATCH');
    const ids = invoices.map(i => nativePaymentId(orgId, i.id));
    const key = `pay:${orgId}:${[...ids].sort().join(':')}`;
    const previous = this.journal.operation(key); if (previous?.hash && previous.state !== 'reverted') return this.confirmed(previous);
    for (const invoice of invoices) {
      const claim = await this.claim(bundle, orgId, invoice);
      if (claim[0] === zeroAddress || claim[3]) throw new DomainError('This claim is unknown or already paid. Refresh chain state.', 'INVALID_STATUS', 409);
      const recipient = (invoice as Invoice & { recipient?: string }).recipient;
      if (!recipient) throw new DomainError('The fixed recipient has not been reconciled.', 'CLAIM_MISMATCH', 409);
      this.checkClaim(claim, invoice, recipient);
    }
    return this.call(orgId, 'caller', key, bundle.vaultAddress as Address, ids.length === 1 ? 'pay' : 'payMany', ids.length === 1 ? [ids[0]] : [ids]);
  }
  async deposit(orgId: string, amount: string, operationKey: string) {
    const bundle = this.requireBundle(orgId); await this.verify(bundle); const n = units(amount);
    await this.send(orgId, 'employer', `approve:${orgId}:${operationKey}`, TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [bundle.vaultAddress as Address, n] }));
    return this.call(orgId, 'employer', `deposit:${orgId}:${operationKey}`, bundle.vaultAddress as Address, 'deposit', [n]);
  }
  async withdraw(orgId: string, amount: string, operationKey: string) {
    const bundle = this.requireBundle(orgId); await this.verify(bundle);
    return this.call(orgId, 'employer', `withdraw:${orgId}:${operationKey}`, bundle.vaultAddress as Address, 'withdrawSurplus', [units(amount)]);
  }
  async retire(orgId: string) { const bundle = this.requireBundle(orgId); await this.verify(bundle); return this.call(orgId, 'employer', `retire:${orgId}`, bundle.vaultAddress as Address, 'retire'); }
  private hashFor(orgId: string, invoice: Invoice, paid: boolean) {
    const paymentId = nativePaymentId(orgId, invoice.id);
    return this.journal.operations(orgId).find(operation => operation.state === 'confirmed' && (paid ? operation.key.startsWith(`pay:${orgId}:`) && operation.key.includes(paymentId) : operation.key === `commit:${orgId}:${invoice.id}`))?.hash;
  }
  private async eventFor(orgId: string, bundle: NativeBundle, invoice: Invoice, paid: boolean, toBlock: bigint): Promise<{ hash: string; at?: string } | null> {
    const key = `event:${orgId}:${invoice.id}:${paid ? 'paid' : 'committed'}`;
    const cached = this.journal.get<{ hash: string; at?: string }>(key); if (cached) return cached;
    try {
      const knownHash = this.hashFor(orgId, invoice, paid);
      const known = knownHash ? this.journal.operations(orgId).find(op => op.hash === knownHash && op.state === 'confirmed') : undefined;
      if (known?.blockNumber) {
        const block = await this.reader.getBlock({ blockNumber: BigInt(known.blockNumber) });
        const event = { hash: known.hash!, at: new Date(Number(block.timestamp) * 1000).toISOString() };
        this.journal.set(key, event); return event;
      }
      const logs = paid
        ? await this.reader.getLogs({ address: bundle.vaultAddress as Address, event: parseAbiItem('event Paid(bytes32 indexed id,address indexed beneficiary,uint256 amount)'), args: { id: nativePaymentId(orgId, invoice.id) }, fromBlock: BigInt(bundle.deploymentBlock), toBlock })
        : await this.reader.getLogs({ address: bundle.vaultAddress as Address, event: parseAbiItem('event Committed(bytes32 indexed id,address indexed beneficiary,uint256 amount,uint64 due)'), args: { id: nativePaymentId(orgId, invoice.id) }, fromBlock: BigInt(bundle.deploymentBlock), toBlock });
      const log = logs[0]; if (!log?.transactionHash || !log.blockNumber) return null;
      const block = await this.reader.getBlock({ blockNumber: log.blockNumber });
      const event = { hash: log.transactionHash, at: new Date(Number(block.timestamp) * 1000).toISOString() };
      this.journal.set(key, event); return event;
    } catch { return null; } // Verified paid state remains truthful even if the event index is unavailable.
  }
  async sync(orgId: string, invoices: Invoice[], workers: Worker[]): Promise<NativeView> {
    const bundle = this.requireBundle(orgId), cacheKey = `view:${orgId}`;
    try {
      // Reconcile hashes first. No new signatures or faucets are needed on reload.
      const unresolved = this.journal.operations(orgId).filter(op => op.state === 'signed');
      if (unresolved.length) await this.verify(bundle);
      for (const operation of unresolved) {
        const owner = randomUUID();
        if (this.journal.lock(operation.wallet, owner)) {
          try { await this.confirmed(operation); } catch { /* A pending hash remains visible; no new transaction is signed. */ }
          finally { this.journal.unlock(operation.wallet, owner); }
        }
      }
      const block = await this.reader.getBlock();
      const wallTime = BigInt(Math.floor(Date.now() / 1000));
      if (block.timestamp < wallTime - 120n || block.timestamp > wallTime + 30n) throw new DomainError('The RPC head is stale or its timestamp differs from the local clock. Check the connection and system clock, then refresh.', 'RPC_HEAD_STALE', 503);
      await this.verify(bundle, block.number);
      const address = bundle.vaultAddress as Address;
      const read = (functionName: string) => this.reader.readContract({ address, abi: this.artifact.abi, functionName, blockNumber: block.number });
      const [liquid, committed, buffer, retired] = await Promise.all([read('liquidBalance'), read('committed'), read('buffer'), read('retired')]) as [bigint, bigint, bigint, boolean];
      const checkedAt = new Date().toISOString(), pending = this.journal.operations(orgId).filter(op => op.state === 'signed');
      const updated = await Promise.all(invoices.map(async invoice => {
        const next = { ...invoice }; const claim = await this.claim(bundle, orgId, invoice, block.number);
        if (claim[0] === zeroAddress && (invoice.status === 'committed' || invoice.status === 'paid')) throw new DomainError('A previously recorded commitment is absent from the observed native block. Chain state cannot be verified.', 'CLAIM_MISMATCH', 503);
        if (claim[0] !== zeroAddress) {
          const worker = workers.find(w => w.id === invoice.workerId); if (!worker) throw new Error('Native invoice has no known recipient.');
          this.checkClaim(claim, invoice, worker.address);
          next.paymentId = nativePaymentId(orgId, invoice.id); next.status = claim[3] ? 'paid' : 'committed';
          next.commitTransactionRef = this.hashFor(orgId, invoice, false) ?? invoice.commitTransactionRef ?? (await this.eventFor(orgId, bundle, invoice, false, block.number))?.hash;
          const paidEvent = claim[3] && (!invoice.paidAt || !invoice.transactionRef || invoice.transactionRef === next.commitTransactionRef) ? await this.eventFor(orgId, bundle, invoice, true, block.number) : null;
          next.transactionRef = claim[3] ? this.hashFor(orgId, invoice, true) ?? paidEvent?.hash ?? invoice.transactionRef : next.commitTransactionRef;
          if (claim[3]) next.paidAt = paidEvent?.at ?? invoice.paidAt;
          else next.paidAt = undefined;
        }
        const operation = pending.find(op => op.key === `commit:${orgId}:${invoice.id}` || op.key.startsWith(`pay:${orgId}:`) && op.key.includes(nativePaymentId(orgId, invoice.id)));
        next.nativePending = operation ? { operation: operation.key.startsWith('commit:') ? 'commit' : 'pay', hash: operation.hash, status: 'submitted' } : undefined;
        return next;
      }));
      const updatedWorkers = await Promise.all(workers.map(async worker => ({ ...worker, received: String(await this.reader.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [worker.address as Address], blockNumber: block.number })) })));
      const protectedBuffer = retired ? 0n : buffer;
      const vault: Vault = { id: 'native_tempo', rail: 'tempo', asset: 'pathUSD', decimals: 6, address, balance: liquid.toString(), committed: committed.toString(), buffer: protectedBuffer.toString(), surplus: (liquid > committed + protectedBuffer ? liquid - committed - protectedBuffer : 0n).toString(), strategyPrincipal: '0', strategyValue: '0', riskMode: 'normal', retired, settlementAvailable: liquid >= committed };
      const view: NativeView = { vault, invoices: updated, workers: updatedWorkers, native: { network: 'Tempo Moderato', chainId: 42431, status: 'live', checkedAt, blockNumber: block.number.toString(), executor: 'managed-test-wallet', employerAddress: bundle.employerAddress, callerAddress: bundle.callerAddress }, now: new Date(Number(block.timestamp) * 1000).toISOString() };
      this.journal.set(cacheKey, view); return view;
    } catch (error) {
      const cached = this.journal.get<NativeView>(cacheKey);
      if (!cached) throw new DomainError('Tempo could not be verified. No live balances are available; retry Refresh when the RPC recovers.', 'NATIVE_UNAVAILABLE', 503);
      return { ...cached, native: { ...cached.native, status: 'stale', warning: error instanceof DomainError ? error.message : 'Tempo RPC is unavailable. Showing the last verified block; native writes are paused.' } };
    }
  }
  async preflight(orgId: string, invoices: Invoice[], workers: Worker[]) {
    const view = await this.sync(orgId, invoices, workers), bundle = this.requireBundle(orgId);
    const [employerFees, callerFees] = await Promise.all([bundle.employerAddress, bundle.callerAddress].map(address => this.reader.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [address as Address] })));
    const pendingTransactions = this.journal.operations(orgId).filter(op => op.state === 'signed').map(op => ({ key: op.key, hash: op.hash }));
    return { ready: !pendingTransactions.length && view.native.status === 'live' && BigInt(view.vault.balance) >= BigInt(view.vault.committed) + BigInt(view.vault.buffer) && BigInt(String(employerFees)) >= 10_000_000n && BigInt(String(callerFees)) >= 10_000_000n && !view.vault.retired, bundle, native: view.native, vault: view.vault, executorTestBalances: { employer: String(employerFees), caller: String(callerFees) }, pendingTransactions, checkedAt: new Date().toISOString() };
  }
}
