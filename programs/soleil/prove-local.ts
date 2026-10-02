import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AccountRole, address, appendTransactionMessageInstructions, createSolanaRpc,
  createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getBase64EncodedWireTransaction,
  getProgramDerivedAddress, lamports, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner,
} from '@solana/kit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RPC_URL = process.env.SOLEIL_SOLANA_PROOF_RPC ?? 'http://127.0.0.1:19099';
const url = new URL(RPC_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('This proof only permits an isolated LOCAL validator.');
const PROGRAM = address(process.env.SOLEIL_SOLANA_PROOF_PROGRAM ?? '7hSDwob28P159bXHhAQrampnvqX8DjaXjSQMKe3bktc3');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = address('11111111111111111111111111111111');
const ATA = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const rpc = createSolanaRpc(RPC_URL);
const addr = getAddressEncoder();
const u64 = (value: bigint) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(value); return data; };
const u32 = (value: number) => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; };
const bytes = (...parts: ArrayLike<number>[]) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(Uint8Array.from(part)))));
const meta = (value: Address, writable = false) => ({ address: value, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
const signed = (signer: KeyPairSigner, writable = false) => ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer });
const ix = (programAddress: Address, accounts: Instruction['accounts'], data: Uint8Array): Instruction => ({ programAddress, accounts, data });
const records: { label: string; signature: string }[] = [];
const checks: { label: string; passed: true }[] = [];
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error('Proof assertion failed: ' + label);
  checks.push({ label, passed: true });
}
async function wait(signature: string) {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const statuses = await rpc.getSignatureStatuses([signature as never]).send();
    const status = statuses.value[0];
    if (status?.err) throw new Error('Confirmed transaction failed: ' + JSON.stringify(status.err, (_, value) => typeof value === 'bigint' ? String(value) : value));
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Local validator confirmation timeout');
}
async function send(label: string, payer: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  let message = createTransactionMessage({ version: 0 });
  const prepared = appendTransactionMessageInstructions(instructions,
    setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayerSigner(payer, message)));
  const transaction = await signTransactionMessageWithSigners(prepared);
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  await wait(signature);
  records.push({ label, signature });
  return signature;
}
async function rejected(label: string, payer: KeyPairSigner, instructions: Instruction[], expectedCustomCode: number) {
  let failure: unknown;
  try { await send(label, payer, instructions); } catch (error) { failure = error; }
  assert(failure, label + ' rejects');
  const detail = JSON.stringify(failure, (_, value) => value instanceof Error
    ? { ...value, name: value.name, message: value.message, cause: value.cause }
    : typeof value === 'bigint' ? String(value) : value);
  const hex = expectedCustomCode.toString(16);
  assert(detail.includes('"Custom":' + expectedCustomCode) || detail.includes('0x' + hex), label + ' has the expected program error ' + expectedCustomCode);
}
async function state(account: Address) {
  const response = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!response.value) throw new Error('Missing account ' + account);
  return Buffer.from(response.value.data[0], 'base64');
}
async function tokenBalance(account: Address) { return BigInt((await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send()).value.amount); }
async function pda(programAddress: Address, seeds: ArrayLike<number>[]) { return (await getProgramDerivedAddress({ programAddress, seeds: seeds.map(seed => Uint8Array.from(seed)) }))[0]; }
async function ata(owner: Address, mint: Address) { return pda(ATA, [addr.encode(owner), addr.encode(TOKEN), addr.encode(mint)]); }
const createAta = (payer: KeyPairSigner, target: Address, owner: Address, mint: Address) =>
  ix(ATA, [signed(payer, true), meta(target, true), meta(owner), meta(mint), meta(SYSTEM), meta(TOKEN)], new Uint8Array([1]));

export async function proveLocalSbf() {
  const program = await rpc.getAccountInfo(PROGRAM, { encoding: 'base64' }).send();
  assert(program.value?.executable, 'actual SBF program is executable on local validator');
  const employer = await generateKeyPairSigner();
  const caller = await generateKeyPairSigner();
  const workerA = await generateKeyPairSigner();
  const workerB = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  for (const signer of [employer, caller]) {
    const signature = await rpc.requestAirdrop(signer.address, lamports(2_000_000_000n)).send();
    await wait(signature); records.push({ label: 'local faucet ' + signer.address, signature });
  }
  const vaultId = crypto.randomBytes(32), paymentA = crypto.randomBytes(32), paymentB = crypto.randomBytes(32), paymentC = crypto.randomBytes(32);
  const vault = await pda(PROGRAM, [Buffer.from('soleil-v1'), addr.encode(employer.address), addr.encode(mint.address), vaultId]);
  const tokenVault = await pda(PROGRAM, [Buffer.from('soleil-token'), addr.encode(vault)]);
  const claimA = await pda(PROGRAM, [Buffer.from('soleil-claim'), addr.encode(vault), paymentA]);
  const claimB = await pda(PROGRAM, [Buffer.from('soleil-claim'), addr.encode(vault), paymentB]);
  const claimC = await pda(PROGRAM, [Buffer.from('soleil-claim'), addr.encode(vault), paymentC]);
  const employerAta = await ata(employer.address, mint.address), workerAtaA = await ata(workerA.address, mint.address), workerAtaB = await ata(workerB.address, mint.address);
  const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const prefundRent = await rpc.getMinimumBalanceForRentExemption(0n).send();
  await send('fresh classic test mint and dust prefunding', employer, [
    ix(SYSTEM, [signed(employer, true), signed(mint, true)], bytes(u32(0), u64(mintRent), u64(82n), addr.encode(TOKEN))),
    ix(TOKEN, [meta(mint.address, true)], bytes([20, 6], addr.encode(employer.address), [1], addr.encode(employer.address))),
    ix(SYSTEM, [signed(employer, true), meta(vault, true)], bytes(u32(2), u64(prefundRent))),
    ix(SYSTEM, [signed(employer, true), meta(claimA, true)], bytes(u32(2), u64(prefundRent))),
  ]);
  await send('initialize actual PDA vault and canonical token PDA', employer, [
    ix(PROGRAM, [signed(employer, true), meta(vault, true), meta(tokenVault, true), meta(mint.address), meta(TOKEN), meta(SYSTEM)], bytes([0], vaultId, u64(50_000_000n))),
    createAta(employer, employerAta, employer.address, mint.address),
    createAta(employer, workerAtaA, workerA.address, mint.address),
    createAta(employer, workerAtaB, workerB.address, mint.address),
    ix(TOKEN, [meta(mint.address, true), meta(employerAta, true), signed(employer)], bytes([7], u64(1_000_000_000n))),
  ]);
  await send('deposit exact classic-token principal', employer, [
    ix(PROGRAM, [signed(employer), meta(vault), meta(tokenVault, true), meta(employerAta, true), meta(mint.address), meta(TOKEN)], bytes([1], u64(1_000_000_000n))),
  ]);
  assert(await tokenBalance(tokenVault) === 1_000_000_000n, 'deposit holds real local classic token balance');
  const due = BigInt(Math.floor(Date.now() / 1000) - 10);
  const commit = (payment: Uint8Array, claim: Address, worker: Address, value: bigint) =>
    ix(PROGRAM, [signed(employer, true), meta(vault, true), meta(tokenVault), meta(claim, true), meta(mint.address), meta(TOKEN), meta(SYSTEM)],
      bytes([2], payment, addr.encode(worker), u64(value), u64(due)));
  await send('commit two immutable invoices with buffered reserve', employer, [
    commit(paymentA, claimA, workerA.address, 100_000_000n), commit(paymentB, claimB, workerB.address, 150_000_000n),
  ]);
  const pay = (payment: Uint8Array, claim: Address, target: Address) =>
    ix(PROGRAM, [meta(vault, true), meta(tokenVault, true), meta(claim, true), meta(target, true), meta(mint.address), meta(TOKEN)], bytes([3], payment));
  const withdraw = (value: bigint) =>
    ix(PROGRAM, [signed(employer), meta(vault), meta(tokenVault, true), meta(employerAta, true), meta(mint.address), meta(TOKEN)], bytes([4], u64(value)));
  assert((await state(vault)).readBigUInt64LE(112) === 250_000_000n, 'on-chain P equals both committed amounts');
  await rejected('withdrawal cannot drain principal and buffer', employer, [withdraw(701_000_000n)], 6007);
  await send('issuer freezes second worker in local test mint', employer, [
    ix(TOKEN, [meta(workerAtaB, true), meta(mint.address), signed(employer)], new Uint8Array([10])),
  ]);
  await rejected('atomic batch denied by frozen second worker', caller, [
    ix(PROGRAM, [meta(vault, true), meta(tokenVault, true), meta(mint.address), meta(TOKEN),
      meta(claimA, true), meta(workerAtaA, true), meta(claimB, true), meta(workerAtaB, true)], bytes([6, 2], paymentA, paymentB)),
  ], 6003);
  assert(await tokenBalance(tokenVault) === 1_000_000_000n && await tokenBalance(workerAtaA) === 0n, 'actual SBF batch rollback restores the first token transfer');
  assert((await state(vault)).readBigUInt64LE(112) === 250_000_000n && (await state(claimA))[120] === 0, 'batch rollback restores P and paid tombstone');
  await send('independent caller settles first fixed worker', caller, [pay(paymentA, claimA, workerAtaA)]);
  assert(await tokenBalance(workerAtaA) === 100_000_000n && await tokenBalance(tokenVault) === 900_000_000n, 'permissionless claim has exact fixed worker delivery');
  assert((await state(vault)).readBigUInt64LE(112) === 150_000_000n && (await state(claimA))[120] === 1, 'successful payment updates real liability and paid state');
  await rejected('paid claim cannot replay', caller, [pay(paymentA, claimA, workerAtaA)], 6009);
  await rejected('paid ID cannot be recommitted', employer, [commit(paymentA, claimA, workerA.address, 1n)], 6006);
  await rejected('cannot retire with outstanding liability', employer, [ix(PROGRAM, [signed(employer), meta(vault, true)], new Uint8Array([5]))], 6012);
  await send('issuer thaws worker and independent caller settles second invoice', employer, [
    ix(TOKEN, [meta(workerAtaB, true), meta(mint.address), signed(employer)], new Uint8Array([11])),
  ]);
  await send('independent caller pays thawed fixed worker', caller, [pay(paymentB, claimB, workerAtaB)]);
  assert(await tokenBalance(workerAtaB) === 150_000_000n && (await state(vault)).readBigUInt64LE(112) === 0n, 'all committed principal is paid exactly once');
  await send('retire without deleting consumed claims', employer, [ix(PROGRAM, [signed(employer), meta(vault, true)], new Uint8Array([5]))]);
  await rejected('retirement permanently blocks new commitments', employer, [commit(paymentC, claimC, workerA.address, 1n)], 6005);
  await send('recover full uncommitted balance including released buffer', employer, [withdraw(750_000_000n)]);
  assert(await tokenBalance(tokenVault) === 0n && await tokenBalance(employerAta) === 750_000_000n, 'retirement recovers company buffer and leaves no token dust');
  const binary = fs.readFileSync(path.join(root, 'programs/soleil/deploy/soleil_vault.so'));
  const evidence = {
    schemaVersion: '1', mode: 'local-validator', cluster: 'localnet', rpcUrl: RPC_URL,
    statement: 'Actual compiled SBF program executed on an isolated local Solana validator. These are local test tokens, not devnet, mainnet, USDC or production funds. No real yield or bridge.',
    verifiedAt: new Date().toISOString(), programId: PROGRAM, programLoading: 'genesis SBF with upgrades disabled',
    programSha256: crypto.createHash('sha256').update(binary).digest('hex'),
    mint: mint.address, decimals: 6, employer: employer.address, independentCaller: caller.address,
    workerA: workerA.address, workerB: workerB.address, vault, vaultTokenAccount: tokenVault,
    paymentIds: [Buffer.from(paymentA).toString('hex'), Buffer.from(paymentB).toString('hex')],
    final: { liquid: '0', committed: '0', retired: true, workerAReceived: '100000000', workerBReceived: '150000000', companyRecovered: '750000000' },
    checks, transactions: records,
    devnet: { deployed: false, reason: 'Official devnet faucet rate-limited fresh isolated deployment signer for two-SOL and one-SOL requests.' },
  };
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/solana-testnet-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ programId: PROGRAM, cluster: evidence.cluster, checks: checks.length, transactions: records.length, evidence: 'public/solana-testnet-evidence.json' }));
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  proveLocalSbf().catch(error => {
    console.error(JSON.stringify(error, (_, value) => value instanceof Error ? { ...value, message: value.message, cause: value.cause } : typeof value === 'bigint' ? String(value) : value));
    process.exitCode = 1;
  });
}




