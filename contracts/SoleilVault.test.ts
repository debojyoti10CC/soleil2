import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createHardhatRuntimeEnvironment } from 'hardhat/hre';
import type { NetworkConnection } from 'hardhat/types/network';
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, keccak256, toBytes, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts';

const chain = defineChain({ id: 1337, name: 'Local contract tests', nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost'] } } });
let artifacts: Record<string, ContractArtifact>;
let connection: NetworkConnection;
let provider: NetworkConnection['provider'];
let publicClient: ReturnType<typeof createPublicClient>;
let wallet: ReturnType<typeof createWalletClient>;
let employer: Address, worker: Address, otherWorker: Address, stranger: Address;
let token: Address, vault: Address, strategy: Address;
const abi = (name: string) => artifacts[name].abi as Abi;
const id = (value: string) => keccak256(toBytes(value));
const read = (address: Address, name: string, fn: string, args: unknown[] = []) =>
  publicClient.readContract({ address, abi: abi(name), functionName: fn, args }) as Promise<unknown>;
async function send(address: Address, name: string, fn: string, args: unknown[] = [], account = employer) {
  const hash = await wallet.writeContract({ address, abi: abi(name), functionName: fn, args, account, chain, gas: 5_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transaction reverted');
  return receipt;
}
async function deploy(name: string, args: unknown[]) {
  const hash = await wallet.deployContract({ abi: abi(name), bytecode: artifacts[name].bytecode, args, account: employer, chain, gas: 8_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deployment reverted');
  return receipt.contractAddress;
}
const balance = (address: Address) => read(token, 'MockTIP20', 'balanceOf', [address]) as Promise<bigint>;
const liability = () => read(vault, 'SoleilVault', 'committed') as Promise<bigint>;
const claim = (payment: Hex) => read(vault, 'SoleilVault', 'claims', [payment]) as Promise<[Address, bigint, bigint, boolean]>;
async function commit(label: string, amount = 100n, recipient = worker, due = 1n) {
  await send(vault, 'SoleilVault', 'commit', [id(label), recipient, amount, due]);
}
beforeAll(() => { artifacts = compileContracts(); });
beforeEach(async () => {
  const environment = await createHardhatRuntimeEnvironment({ networks: { proof: { type: 'edr-simulated', chainType: 'l1', chainId: 1337, hardfork: 'shanghai', throwOnTransactionFailures: false } } });
  connection = await environment.network.create('proof');
  provider = connection.provider;
  const transport = custom(provider as never);
  publicClient = createPublicClient({ chain, transport });
  wallet = createWalletClient({ chain, transport });
  [employer, worker, otherWorker, stranger] = await wallet.getAddresses();
  token = await deploy('MockTIP20', []);
  strategy = await deploy('MockSurplusStrategy', [token]);
  vault = await deploy('SoleilVault', [token, employer, 50n, strategy]);
  await send(token, 'MockTIP20', 'mint', [employer, 1_000n]);
  await send(token, 'MockTIP20', 'approve', [vault, 1_000n]);
  await send(vault, 'SoleilVault', 'deposit', [1_000n]);
});
afterEach(async () => { await connection?.close(); });

describe('Soleil immutable Tempo vault: executable EVM invariants', () => {
  it('requires employer and buffered coverage; exposes fixed fields and pays permissionlessly', async () => {
    await expect(send(vault, 'SoleilVault', 'commit', [id('unauthorized'), worker, 10n, 1n], stranger)).rejects.toThrow();
    await expect(commit('overdraw', 951n)).rejects.toThrow();
    expect(await liability()).toBe(0n);
    await commit('accepted');
    expect(await claim(id('accepted'))).toEqual([worker, 100n, 1n, false]);
    await expect(commit('accepted', 5n, stranger)).rejects.toThrow();
    await send(vault, 'SoleilVault', 'pay', [id('accepted')], stranger);
    expect(await balance(worker)).toBe(100n);
    expect(await liability()).toBe(0n);
    expect((await claim(id('accepted')))[3]).toBe(true);
    await expect(commit('accepted', 1n)).rejects.toThrow();
    await expect(send(vault, 'SoleilVault', 'pay', [id('accepted')], worker)).rejects.toThrow();
  });

  it('uses chain time rather than application authorization to unlock payment', async () => {
    const due = (await publicClient.getBlock()).timestamp + 3_600n;
    await commit('future', 200n, worker, due);
    await expect(send(vault, 'SoleilVault', 'pay', [id('future')], worker)).rejects.toThrow();
    expect(await liability()).toBe(200n);
    await provider.request({ method: 'evm_increaseTime', params: [3_601] });
    await provider.request({ method: 'evm_mine', params: [] });
    await send(vault, 'SoleilVault', 'pay', [id('future')], stranger);
    expect(await balance(worker)).toBe(200n);
  });

  it('rolls back nominal-success ReceivePolicyGuard redirection in the same transaction', async () => {
    await commit('guard');
    await send(token, 'MockTIP20', 'setRedirected', [worker, true]);
    await expect(send(vault, 'SoleilVault', 'pay', [id('guard')], stranger)).rejects.toThrow();
    expect(await balance(vault)).toBe(1_000n);
    expect(await balance(worker)).toBe(0n);
    expect(await balance('0xB10C000000000000000000000000000000000000')).toBe(0n);
    expect(await liability()).toBe(100n);
    expect((await claim(id('guard')))[3]).toBe(false);
    await send(token, 'MockTIP20', 'setRedirected', [worker, false]);
    await send(vault, 'SoleilVault', 'pay', [id('guard')], stranger);
    expect(await balance(worker)).toBe(100n);
  });

  it('keeps an atomic batch intact after one denied recipient and retains individual claims', async () => {
    await commit('a', 100n);
    await commit('b', 150n, otherWorker);
    await send(token, 'MockTIP20', 'setBlocked', [otherWorker, true]);
    await expect(send(vault, 'SoleilVault', 'payMany', [[id('a'), id('b')]], stranger)).rejects.toThrow();
    expect(await liability()).toBe(250n);
    expect(await balance(worker)).toBe(0n);
    expect((await claim(id('a')))[3]).toBe(false);
    await send(vault, 'SoleilVault', 'pay', [id('a')], worker);
    expect(await liability()).toBe(150n);
    expect(await balance(worker)).toBe(100n);
  });

  it('blocks duplicate IDs atomically and rejects empty or oversized batches', async () => {
    await expect(send(vault, 'SoleilVault', 'commitMany', [[id('dup'), id('dup')], [worker, otherWorker], [100n, 100n], [1n, 1n]])).rejects.toThrow();
    expect(await liability()).toBe(0n);
    await commit('dup');
    await expect(send(vault, 'SoleilVault', 'payMany', [[id('dup'), id('dup')]])).rejects.toThrow();
    expect(await liability()).toBe(100n);
    expect(await balance(worker)).toBe(0n);
    await expect(send(vault, 'SoleilVault', 'payMany', [[]])).rejects.toThrow();
    await expect(send(vault, 'SoleilVault', 'payMany', [Array.from({ length: 33 }, (_, i) => id(String(i)))])).rejects.toThrow();
  });

  it('pays with deficient buffer but stops all first-claimant preference after issuer principal loss', async () => {
    await commit('buffer', 300n);
    await send(token, 'MockTIP20', 'slash', [vault, 700n]);
    await send(vault, 'SoleilVault', 'pay', [id('buffer')], stranger);
    expect(await balance(worker)).toBe(300n);
    expect(await liability()).toBe(0n);
  });

  it('allows partial recapitalization below reserve, while every claim stays blocked until P is covered', async () => {
    await commit('lossA', 300n);
    await commit('lossB', 200n, otherWorker);
    await send(token, 'MockTIP20', 'slash', [vault, 600n]);
    await expect(send(vault, 'SoleilVault', 'pay', [id('lossA')], stranger)).rejects.toThrow();
    await expect(send(vault, 'SoleilVault', 'pay', [id('lossB')], stranger)).rejects.toThrow();
    await send(token, 'MockTIP20', 'mint', [stranger, 100n]);
    await send(token, 'MockTIP20', 'approve', [vault, 100n], stranger);
    await send(vault, 'SoleilVault', 'deposit', [40n], stranger);
    expect(await balance(vault)).toBe(440n);
    await expect(send(vault, 'SoleilVault', 'pay', [id('lossB')], stranger)).rejects.toThrow();
    await send(vault, 'SoleilVault', 'deposit', [60n], stranger);
    await send(vault, 'SoleilVault', 'payMany', [[id('lossA'), id('lossB')]], stranger);
    expect(await balance(worker)).toBe(300n);
    expect(await balance(otherWorker)).toBe(200n);
    expect(await liability()).toBe(0n);
  });

  it('isolates simulated surplus loss and delay from committed funds, clears standing approvals', async () => {
    await commit('protected', 400n);
    await expect(send(vault, 'SoleilVault', 'allocateSurplus', [551n])).rejects.toThrow();
    await send(vault, 'SoleilVault', 'allocateSurplus', [500n]);
    expect(await balance(vault)).toBe(500n);
    expect(await read(token, 'MockTIP20', 'allowance', [vault, strategy])).toBe(0n);
    await send(strategy, 'MockSurplusStrategy', 'simulateLoss', [vault, 100n]);
    await send(strategy, 'MockSurplusStrategy', 'simulateDelay', [vault, true]);
    await expect(send(vault, 'SoleilVault', 'recoverStrategy', [100n, 100n])).rejects.toThrow();
    await send(vault, 'SoleilVault', 'pay', [id('protected')], stranger);
    expect(await balance(worker)).toBe(400n);
    expect(await balance(vault)).toBe(100n);
    expect(await liability()).toBe(0n);
  });

  it('recovers strategy inflows even while issuer loss leaves principal below P', async () => {
    await commit('recovery', 600n);
    await send(vault, 'SoleilVault', 'allocateSurplus', [300n]);
    await send(token, 'MockTIP20', 'slash', [vault, 200n]);
    await send(vault, 'SoleilVault', 'recoverStrategy', [50n, 50n]);
    expect(await balance(vault)).toBe(550n);
    expect(await liability()).toBe(600n);
    await expect(send(vault, 'SoleilVault', 'pay', [id('recovery')])).rejects.toThrow();
    await send(vault, 'SoleilVault', 'recoverStrategy', [50n, 50n]);
    await send(vault, 'SoleilVault', 'pay', [id('recovery')], stranger);
    expect(await balance(worker)).toBe(600n);
  });

  it('retires only without liabilities, releases the buffer and permanently preserves consumed IDs', async () => {
    await commit('retire');
    await expect(send(vault, 'SoleilVault', 'retire')).rejects.toThrow();
    await expect(send(vault, 'SoleilVault', 'withdrawSurplus', [851n])).rejects.toThrow();
    await send(vault, 'SoleilVault', 'pay', [id('retire')], stranger);
    await send(vault, 'SoleilVault', 'retire');
    expect(await read(vault, 'SoleilVault', 'surplus')).toBe(900n);
    await send(vault, 'SoleilVault', 'withdrawSurplus', [900n]);
    expect(await balance(vault)).toBe(0n);
    await expect(commit('newAfterRetirement', 1n)).rejects.toThrow();
    expect((await claim(id('retire')))[3]).toBe(true);
  });

  it('rejects virtual aliases and token addresses; fee-on-transfer cannot be recorded as paid', async () => {
    await expect(commit('virtual', 100n, '0x01020304FDFDFDFDFDFDFDFDFDFD010203040506')).rejects.toThrow();
    await expect(commit('tokenRecipient', 100n, '0x20c0000000000000000000000000000000000001')).rejects.toThrow();
    await commit('fee');
    await send(token, 'MockTIP20', 'setFeeEnabled', [true]);
    await expect(send(vault, 'SoleilVault', 'pay', [id('fee')], stranger)).rejects.toThrow();
    expect(await liability()).toBe(100n);
    expect(await balance(vault)).toBe(1_000n);
    expect(await balance(worker)).toBe(0n);
  });

  it('prevents token callback reentry and rolls back paid flags when a hostile callback reverts', async () => {
    await commit('reentry');
    const call = encodeFunctionData({ abi: abi('SoleilVault'), functionName: 'pay', args: [id('reentry')] });
    await send(token, 'MockTIP20', 'setCallback', [vault, call, true]);
    await expect(send(vault, 'SoleilVault', 'pay', [id('reentry')], stranger)).rejects.toThrow();
    expect(await liability()).toBe(100n);
    expect((await claim(id('reentry')))[3]).toBe(false);
    await send(token, 'MockTIP20', 'setCallback', [vault, call, false]);
    await send(vault, 'SoleilVault', 'pay', [id('reentry')], stranger);
    expect(await balance(worker)).toBe(100n);
    expect(await liability()).toBe(0n);
  });
});

