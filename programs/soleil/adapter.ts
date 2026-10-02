import {
  AccountRole, address, createSolanaRpc, getAddressDecoder, getAddressEncoder,
  getProgramDerivedAddress, type Address, type Instruction, type TransactionSigner,
} from '@solana/kit';

export const CLASSIC_TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const LEGACY_LOADER = address('BPFLoader2111111111111111111111111111111111');
const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
const SYSVAR_OWNER = address('Sysvar1111111111111111111111111111111111111');
const encoder = getAddressEncoder(), decoder = getAddressDecoder(), text = new TextEncoder();
const concat = (...parts: ArrayLike<number>[]) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { result.set(Uint8Array.from(part), offset); offset += part.length; }
  return result;
};
const u64 = (value: bigint) => {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('Amount outside u64');
  const data = new Uint8Array(8); new DataView(data.buffer).setBigUint64(0, value, true); return data;
};
const i64 = (value: bigint) => {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw new Error('Due outside i64');
  const data = new Uint8Array(8); new DataView(data.buffer).setBigInt64(0, value, true); return data;
};
const meta = (value: Address, writable = false) => ({ address: value, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
const signed = (signer: TransactionSigner, writable = false) =>
  ({ address: signer.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer });
const base64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const hex = (data: Uint8Array) => [...data].map(value => value.toString(16).padStart(2, '0')).join('');
const addressAt = (data: Uint8Array, offset: number) => decoder.decode(data.subarray(offset, offset + 32));
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function idFromHex(value: string) {
  assert(/^[0-9a-fA-F]{64}$/.test(value), 'A payment/vault ID must contain exactly 32 bytes of hex');
  return Uint8Array.from(value.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
}
function id(value: Uint8Array) { assert(value.length === 32, 'Expected 32-byte immutable ID'); return value; }

export interface SoleilSolanaConfig {
  rpcUrl: string; cluster: 'devnet' | 'local-validator'; expectedGenesisHash: string;
  programId: Address; programSha256: string; mint: Address;
}
export interface NativeVault {
  employer: Address; mint: Address; vaultId: string; buffer: bigint; committed: bigint; retired: boolean; bump: number;
}
export interface NativeClaim {
  vault: Address; paymentId: string; beneficiary: Address; amount: bigint; due: bigint; paid: boolean; bump: number;
}
export interface NativeSolanaSnapshot {
  mode: 'solana-devnet' | 'solana-local-validator'; cluster: 'devnet' | 'local-validator';
  checkedAt: string; slot: string; blockTime: string; rpcOrigin: string; programId: Address;
  actualMint: Address; decimals: 6; vault: Address; vaultTokenAccount: Address;
  liquid: string; committed: string; buffer: string; principalCovered: boolean; bufferCovered: boolean;
  surplus: string; retired: boolean; tokenFrozen: boolean; mintHasFreezeAuthority: boolean;
  claims: Array<{ commitmentAddress: Address; paymentId: string; beneficiary: Address; destination: Address;
    amount: string; due: string; paid: boolean; dueByObservedClock: boolean }>;
}
export function decodeVault(data: Uint8Array): NativeVault {
  assert(data.length === 122 && new TextDecoder().decode(data.subarray(0, 8)) === 'SOLVAU01', 'Invalid Soleil vault version/length');
  assert(data[120] <= 1, 'Invalid retired flag');
  return { employer: addressAt(data, 8), mint: addressAt(data, 40), vaultId: hex(data.subarray(72, 104)),
    buffer: view(data).getBigUint64(104, true), committed: view(data).getBigUint64(112, true),
    retired: data[120] === 1, bump: data[121] };
}
export function decodeClaim(data: Uint8Array): NativeClaim {
  assert(data.length === 122 && new TextDecoder().decode(data.subarray(0, 8)) === 'SOLCLM01', 'Invalid Soleil claim version/length');
  assert(data[120] <= 1, 'Invalid paid flag');
  return { vault: addressAt(data, 8), paymentId: hex(data.subarray(40, 72)), beneficiary: addressAt(data, 72),
    amount: view(data).getBigUint64(104, true), due: view(data).getBigInt64(112, true),
    paid: data[120] === 1, bump: data[121] };
}

/** Explicit testnet adapter: never loads a wallet, submits a transaction or falls back to a mock. */
export function createSoleilSolanaAdapter(input: SoleilSolanaConfig) {
  const config = Object.freeze({ ...input }), endpoint = new URL(config.rpcUrl);
  assert(/^[0-9a-f]{64}$/.test(config.programSha256), 'Pin the actual compiled SBF SHA-256');
  assert(Boolean(config.expectedGenesisHash), 'An explicit genesis hash is required');
  if (config.cluster === 'devnet') assert(config.expectedGenesisHash === DEVNET_GENESIS, 'Devnet genesis must be pinned');
  else assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Local validator requires loopback RPC');
  const rpc = createSolanaRpc(config.rpcUrl);
  let trustedUntil = 0;
  const pda = (programAddress: Address, seeds: ArrayLike<number>[]) =>
    getProgramDerivedAddress({ programAddress, seeds: seeds.map(seed => Uint8Array.from(seed)) });
  const deriveAta = async (owner: Address) => (await pda(ATA_PROGRAM, [encoder.encode(owner), encoder.encode(CLASSIC_TOKEN), encoder.encode(config.mint)]))[0];
  const deriveVault = async (employer: Address, vaultId: Uint8Array) => {
    const [vault, bump] = await pda(config.programId, [text.encode('soleil-v1'), encoder.encode(employer), encoder.encode(config.mint), id(vaultId)]);
    const tokenVault = (await pda(config.programId, [text.encode('soleil-token'), encoder.encode(vault)]))[0];
    return { vault, tokenVault, bump };
  };
  const deriveClaim = (vault: Address, paymentId: Uint8Array) => pda(config.programId, [text.encode('soleil-claim'), encoder.encode(vault), id(paymentId)]);
  async function verifyProgram() {
    assert(await rpc.getGenesisHash().send() === config.expectedGenesisHash, 'RPC is connected to the wrong cluster');
    const account = (await rpc.getAccountInfo(config.programId, { encoding: 'base64', commitment: 'confirmed' }).send()).value;
    assert(account?.executable, 'The configured native program is not executable');
    let code: Uint8Array;
    if (account.owner === UPGRADEABLE_LOADER) {
      const program = base64(account.data[0]);
      assert(program.length === 36 && view(program).getUint32(0, true) === 2, 'Invalid upgradeable-loader program account');
      const programData = (await rpc.getAccountInfo(addressAt(program, 4), { encoding: 'base64', commitment: 'confirmed' }).send()).value;
      assert(programData?.owner === UPGRADEABLE_LOADER && !programData.executable, 'Invalid native program-data account');
      const data = base64(programData.data[0]);
      assert(data.length > 45 && view(data).getUint32(0, true) === 3 && data[12] === 0,
        'Deployment still has an upgrade authority or invalid program metadata');
      code = data.subarray(45);
    } else {
      assert(config.cluster === 'local-validator' && account.owner === LEGACY_LOADER, 'Unexpected native program loader');
      code = base64(account.data[0]);
    }
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(code).buffer)));
    assert(digest === config.programSha256, 'Deployed SBF differs from the pinned artifact (including allocation padding)');
    const mint = (await rpc.getAccountInfo(config.mint, { encoding: 'base64', commitment: 'confirmed' }).send()).value;
    assert(mint?.owner === CLASSIC_TOKEN && !mint.executable, 'Asset must use the classic SPL Token program');
    const data = base64(mint.data[0]);
    assert(data.length === 82 && data[44] === 6 && data[45] === 1, 'Asset is not an initialized six-decimal classic mint');
    trustedUntil = Date.now() + 30_000;
    return { cluster: config.cluster, programId: config.programId, programSha256: digest, mint: config.mint, immutable: true as const };
  }
  async function trusted() { if (Date.now() >= trustedUntil) await verifyProgram(); }
  const ix = (accounts: Instruction['accounts'], data: Uint8Array): Instruction => ({ programAddress: config.programId, accounts, data });
  const tokenPda = async (vault: Address) => (await pda(config.programId, [text.encode('soleil-token'), encoder.encode(vault)]))[0];
  async function initialize(employer: TransactionSigner, vaultId: Uint8Array, buffer: bigint) {
    await trusted(); const { vault, tokenVault } = await deriveVault(employer.address, vaultId);
    return ix([signed(employer, true), meta(vault, true), meta(tokenVault, true), meta(config.mint), meta(CLASSIC_TOKEN), meta(SYSTEM_PROGRAM)],
      concat([0], id(vaultId), u64(buffer)));
  }
  async function deposit(depositor: TransactionSigner, vault: Address, source: Address, amount: bigint) {
    await trusted(); assert(amount > 0n, 'Deposit must be positive');
    return ix([signed(depositor), meta(vault), meta(await tokenPda(vault), true), meta(source, true), meta(config.mint), meta(CLASSIC_TOKEN)], concat([1], u64(amount)));
  }
  async function commit(employer: TransactionSigner, vault: Address, paymentId: Uint8Array, beneficiary: Address, amount: bigint, due: bigint) {
    await trusted(); assert(amount > 0n && due >= 0n, 'Commitment requires a positive amount and nonnegative due time');
    return ix([signed(employer, true), meta(vault, true), meta(await tokenPda(vault)), meta((await deriveClaim(vault, paymentId))[0], true),
      meta(config.mint), meta(CLASSIC_TOKEN), meta(SYSTEM_PROGRAM)],
      concat([2], id(paymentId), encoder.encode(beneficiary), u64(amount), i64(due)));
  }
  async function pay(vault: Address, paymentId: Uint8Array, beneficiary: Address) {
    await trusted();
    return ix([meta(vault, true), meta(await tokenPda(vault), true), meta((await deriveClaim(vault, paymentId))[0], true),
      meta(await deriveAta(beneficiary), true), meta(config.mint), meta(CLASSIC_TOKEN)], concat([3], id(paymentId)));
  }
  async function payMany(vault: Address, claims: { paymentId: Uint8Array; beneficiary: Address }[]) {
    await trusted(); assert(claims.length > 0 && claims.length <= 16, 'Batch supports 1 to 16 claims; transaction limits may require fewer');
    const ids = claims.map(claim => hex(id(claim.paymentId))); assert(new Set(ids).size === ids.length, 'Batch repeats a payment ID');
    const accounts = [meta(vault, true), meta(await tokenPda(vault), true), meta(config.mint), meta(CLASSIC_TOKEN)];
    for (const claim of claims) accounts.push(meta((await deriveClaim(vault, claim.paymentId))[0], true), meta(await deriveAta(claim.beneficiary), true));
    return ix(accounts, concat([6, claims.length], ...claims.map(claim => claim.paymentId)));
  }
  async function withdraw(employer: TransactionSigner, vault: Address, amount: bigint) {
    await trusted(); assert(amount > 0n, 'Withdrawal must be positive');
    return ix([signed(employer), meta(vault), meta(await tokenPda(vault), true), meta(await deriveAta(employer.address), true),
      meta(config.mint), meta(CLASSIC_TOKEN)], concat([4], u64(amount)));
  }
  async function retire(employer: TransactionSigner, vault: Address) {
    await trusted(); return ix([signed(employer), meta(vault, true)], new Uint8Array([5]));
  }
  async function createRecipientAta(payer: TransactionSigner, beneficiary: Address): Promise<Instruction> {
    await trusted(); return { programAddress: ATA_PROGRAM, accounts: [signed(payer, true), meta(await deriveAta(beneficiary), true),
      meta(beneficiary), meta(config.mint), meta(SYSTEM_PROGRAM), meta(CLASSIC_TOKEN)], data: new Uint8Array([1]) };
  }
  async function snapshot(employer: Address, vaultId: Uint8Array, paymentIds: Uint8Array[] = []): Promise<NativeSolanaSnapshot> {
    await trusted(); const derived = await deriveVault(employer, vaultId);
    assert(paymentIds.length <= 96, 'One coherent RPC snapshot supports at most 96 claims');
    const claims = await Promise.all(paymentIds.map(value => deriveClaim(derived.vault, value)));
    const response = await rpc.getMultipleAccounts([derived.vault, derived.tokenVault, config.mint, CLOCK, ...claims.map(value => value[0])],
      { encoding: 'base64', commitment: 'confirmed' }).send();
    const [vaultAccount, tokenAccount, mintAccount, clockAccount, ...claimAccounts] = response.value;
    assert(vaultAccount?.owner === config.programId && !vaultAccount.executable, 'Missing or foreign vault account');
    const vault = decodeVault(base64(vaultAccount.data[0]));
    assert(vault.employer === employer && vault.mint === config.mint && vault.vaultId === hex(vaultId) && vault.bump === derived.bump, 'Vault identity differs from the canonical PDA');
    assert(tokenAccount?.owner === CLASSIC_TOKEN && !tokenAccount.executable, 'Missing or foreign vault token account');
    const token = base64(tokenAccount.data[0]); assert(token.length === 165, 'Invalid classic token account length');
    const tokenView = view(token);
    assert(addressAt(token, 0) === config.mint && addressAt(token, 32) === derived.vault &&
      tokenView.getUint32(72, true) === 0 && tokenView.getUint32(109, true) === 0 &&
      tokenView.getBigUint64(121, true) === 0n && tokenView.getUint32(129, true) === 0 &&
      (token[108] === 1 || token[108] === 2), 'Vault token authority/delegate/native/close/state differs from the contract');
    assert(mintAccount?.owner === CLASSIC_TOKEN && !mintAccount.executable, 'Asset changed token program');
    const mint = base64(mintAccount.data[0]);
    assert(mint.length === 82 && mint[44] === 6 && mint[45] === 1, 'Asset mint changed');
    assert(clockAccount?.owner === SYSVAR_OWNER, 'Missing or invalid chain clock');
    const clock = base64(clockAccount.data[0]); assert(clock.length >= 40, 'Invalid chain clock length');
    const chainTime = view(clock).getBigInt64(32, true), liquid = tokenView.getBigUint64(64, true);
    const reserve = vault.committed + (vault.retired ? 0n : vault.buffer);
    const entries: NativeSolanaSnapshot['claims'] = [];
    for (let index = 0; index < claimAccounts.length; index++) {
      const account = claimAccounts[index]; assert(account?.owner === config.programId && !account.executable, 'Missing or foreign committed claim');
      const claim = decodeClaim(base64(account.data[0]));
      assert(claim.vault === derived.vault && claim.paymentId === hex(paymentIds[index]) && claim.bump === claims[index][1] &&
        claim.amount > 0n && claim.due >= 0n, 'Claim identity/amount/due differs from the canonical PDA');
      entries.push({ commitmentAddress: claims[index][0], paymentId: claim.paymentId, beneficiary: claim.beneficiary,
        destination: await deriveAta(claim.beneficiary), amount: String(claim.amount), due: String(claim.due),
        paid: claim.paid, dueByObservedClock: chainTime >= claim.due });
    }
    return { mode: config.cluster === 'devnet' ? 'solana-devnet' : 'solana-local-validator', cluster: config.cluster,
      checkedAt: new Date().toISOString(), slot: String(response.context.slot), blockTime: String(chainTime), rpcOrigin: endpoint.origin,
      programId: config.programId, actualMint: config.mint, decimals: 6, vault: derived.vault, vaultTokenAccount: derived.tokenVault,
      liquid: String(liquid), committed: String(vault.committed), buffer: String(vault.buffer), principalCovered: liquid >= vault.committed,
      bufferCovered: liquid >= reserve, surplus: String(liquid > reserve ? liquid - reserve : 0n), retired: vault.retired,
      tokenFrozen: token[108] === 2, mintHasFreezeAuthority: view(mint).getUint32(46, true) !== 0, claims: entries };
  }
  return { config, rpc, verifyProgram, deriveVault, deriveClaim, deriveAta, initialize, deposit, commit, pay, payMany, withdraw, retire, createRecipientAta, snapshot };
}

