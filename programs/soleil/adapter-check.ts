import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { address, getAddressEncoder } from '@solana/kit';
import { CLASSIC_TOKEN, DEVNET_USDC, createSoleilSolanaAdapter, decodeClaim, idFromHex } from './adapter.js';

const binary = fs.readFileSync(process.env.SOLEIL_SBF_ARTIFACT ?? new URL('./deploy/soleil_vault.so', import.meta.url));
const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
const PROGRAM = address('7hSDwob28P159bXHhAQrampnvqX8DjaXjSQMKe3bktc3');
const EMPLOYER = address('6No9y9AwTpnvpcTYisNBbYwxix7C9B5ayJi8UWfM9tP3');
const WORKER = address('7whjovxbfYbgXvUsQnKKREgLfhx2quHFKxqRfqBQRSUf');
const PROGRAM_DATA = address('7T392veAG3VMrQ1xFRvk8UP7hph7mVYjKx5g1U38RgmK');
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LEGACY = 'BPFLoader2111111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const encode = getAddressEncoder();
type Account = { data: [string, 'base64']; executable: boolean; lamports: number; owner: string; rentEpoch: number; space: number };
function account(data: Uint8Array, owner: string, executable = false): Account {
  return { data: [Buffer.from(data).toString('base64'), 'base64'], executable, lamports: 1, owner, rentEpoch: 0, space: data.length };
}
let genesis = 'isolated-unit-fixture';
const accounts = new Map<string, Account>();
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += String(part);
  const json = JSON.parse(body); let result: unknown;
  if (json.method === 'getGenesisHash') result = genesis;
  else if (json.method === 'getAccountInfo') result = { context: { slot: 123 }, value: accounts.get(json.params[0]) ?? null };
  else if (json.method === 'getMultipleAccounts') result = { context: { slot: 123 }, value: json.params[0].map((key: string) => accounts.get(key) ?? null) };
  else { response.writeHead(400); response.end('unexpected method'); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const config = { rpcUrl: 'http://127.0.0.1:' + port, cluster: 'local-validator' as const, expectedGenesisHash: genesis,
  programId: PROGRAM, programSha256: sha256, mint: DEVNET_USDC };
const adapter = () => createSoleilSolanaAdapter(config);
const vaultId = idFromHex('11'.repeat(32)), paymentId = idFromHex('22'.repeat(32));
const { vault, tokenVault, bump } = await adapter().deriveVault(EMPLOYER, vaultId);
const [claimAddress, claimBump] = await adapter().deriveClaim(vault, paymentId);
function base() {
  accounts.clear(); genesis = config.expectedGenesisHash;
  accounts.set(PROGRAM, account(binary, LEGACY, true));
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1; mint.writeUInt32LE(1, 46);
  accounts.set(DEVNET_USDC, account(mint, CLASSIC_TOKEN));
  const vaultData = Buffer.alloc(122); vaultData.write('SOLVAU01'); vaultData.set(encode.encode(EMPLOYER), 8);
  vaultData.set(encode.encode(DEVNET_USDC), 40); vaultData.set(vaultId, 72); vaultData.writeBigUInt64LE(1_000_000n, 104); vaultData[121] = bump;
  accounts.set(vault, account(vaultData, PROGRAM));
  const token = Buffer.alloc(165); token.set(encode.encode(DEVNET_USDC), 0); token.set(encode.encode(vault), 32);
  token.writeBigUInt64LE(10_000_000n, 64); token[108] = 1; accounts.set(tokenVault, account(token, CLASSIC_TOKEN));
  const claim = Buffer.alloc(122); claim.write('SOLCLM01'); claim.set(encode.encode(vault), 8); claim.set(paymentId, 40);
  claim.set(encode.encode(WORKER), 72); claim.writeBigUInt64LE(2_000_000n, 104); claim.writeBigInt64LE(1_699_999_999n, 112);
  claim[120] = 1; claim[121] = claimBump; accounts.set(claimAddress, account(claim, PROGRAM));
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(1_700_000_000n, 32); accounts.set(CLOCK, account(clock, SYSVAR_OWNER));
}
function edit(address: string, callback: (data: Buffer) => void) {
  const value = accounts.get(address)!; const data = Buffer.from(value.data[0], 'base64'); callback(data); value.data[0] = data.toString('base64');
}
let count = 0;
async function rejection(message: RegExp, action: () => Promise<unknown>) { await assert.rejects(action, message); count++; }
try {
  base(); await adapter().verifyProgram(); count++;
  const snapshot = await adapter().snapshot(EMPLOYER, vaultId, [paymentId]);
  assert.equal(snapshot.mode, 'solana-local-validator'); assert.equal(snapshot.slot, '123');
  assert.equal(snapshot.blockTime, '1700000000'); assert.equal(snapshot.actualMint, DEVNET_USDC);
  assert.equal(snapshot.liquid, '10000000'); assert.equal(snapshot.committed, '0'); assert.equal(snapshot.surplus, '9000000');
  assert.equal(snapshot.claims[0].paid, true); assert.equal(snapshot.claims[0].dueByObservedClock, true);
  assert.equal(snapshot.mintHasFreezeAuthority, true); count++;
  const instruction = await adapter().pay(vault, paymentId, WORKER);
  assert.equal(instruction.programAddress, PROGRAM); assert.equal(instruction.data?.length, 33);
  assert.equal(instruction.accounts?.length, 6); assert(instruction.accounts?.every(value => value.role === 0 || value.role === 1)); count++;
  genesis = 'wrong-chain'; await rejection(/wrong cluster/, () => adapter().verifyProgram());
  base(); config.programSha256 = '00'.repeat(32); await rejection(/differs from the pinned artifact/, () => adapter().verifyProgram()); config.programSha256 = sha256;
  base(); const program = Buffer.alloc(36); program.writeUInt32LE(2); program.set(encode.encode(PROGRAM_DATA), 4);
  const data = Buffer.concat([Buffer.alloc(45), binary]); data.writeUInt32LE(3); data[12] = 1;
  accounts.set(PROGRAM, account(program, UPGRADEABLE, true)); accounts.set(PROGRAM_DATA, account(data, UPGRADEABLE));
  await rejection(/upgrade authority/, () => adapter().verifyProgram());
  data[12] = 0; accounts.set(PROGRAM_DATA, account(data, UPGRADEABLE)); await adapter().verifyProgram(); count++;
  base(); accounts.get(DEVNET_USDC)!.owner = PROGRAM; await rejection(/classic SPL Token/, () => adapter().verifyProgram());
  base(); edit(vault, data => data[121] ^= 1); await rejection(/canonical PDA/, () => adapter().snapshot(EMPLOYER, vaultId));
  base(); edit(tokenVault, data => data.writeUInt32LE(1, 72)); await rejection(/delegate/, () => adapter().snapshot(EMPLOYER, vaultId));
  base(); accounts.get(claimAddress)!.owner = CLASSIC_TOKEN; await rejection(/foreign committed claim/, () => adapter().snapshot(EMPLOYER, vaultId, [paymentId]));
  base(); edit(claimAddress, data => data[120] = 2); await rejection(/paid flag/, () => adapter().snapshot(EMPLOYER, vaultId, [paymentId]));
  base(); edit(tokenVault, data => data[108] = 2); assert.equal((await adapter().snapshot(EMPLOYER, vaultId)).tokenFrozen, true); count++;
  assert.throws(() => idFromHex('22'), /exactly 32 bytes/); assert.throws(() => decodeClaim(new Uint8Array(122)), /version/); count++;
  console.log(JSON.stringify({ checks: count, statement: 'Adapter-only security tests against an isolated RPC fixture; no chain transaction, wallet or funding action.', artifactSha256: sha256 }));
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }


