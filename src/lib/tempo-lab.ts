import { createClient, Account } from 'viem/tempo';
import { tempoModerato } from 'viem/chains';
import { generatePrivateKey } from 'viem/accounts';
import { http, parseAbi, parseUnits, keccak256, toHex, isAddress, BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from 'viem';
import { matchesVaultRuntime } from './verify-runtime';
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const;
export const MODERATO_RPC = 'https://rpc.moderato.tempo.xyz';
export const EXPLORER = 'https://explore.testnet.tempo.xyz';
export const tokenAbi = parseAbi(['function balanceOf(address account) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)', 'function decimals() view returns (uint8)']);
export function createTestWallet(rpcUrl = MODERATO_RPC) {
  // Generated keys stay in memory. Never exported, saved, logged or used on mainnet.
  const account = Account.fromSecp256k1(generatePrivateKey());
  return createClient({ account, chain: tempoModerato, feeToken: PATH_USD, transport: http(rpcUrl, { timeout: 15000, retryCount: 1 }) });
}
export function createTestReader(rpcUrl = MODERATO_RPC) { return createClient({ chain: tempoModerato, transport: http(rpcUrl, { timeout: 15000, retryCount: 1 }) }); }
export type TestWallet = ReturnType<typeof createTestWallet>;
export interface VaultArtifact { abi: Abi; bytecode: Hex; deployedBytecode?: Hex; immutableReferences?: Record<string, { start: number; length: number }[]>; }
export interface LabEvidence { network: 'Tempo Moderato'; chainId: 42431; token: Address; vault: Address; employer: Address; recipient: Address; caller: Address; paymentId: Hex; amount: string; dueAt: number; transactionHashes: Hex[]; verified: boolean; recipientBalance: string; committedAfter: string; createdAt: string; }
export interface FundedCommitment { network: 'Tempo Moderato'; chainId: 42431; token: Address; vault: Address; employer: Address; recipient: Address; paymentId: Hex; amount: string; dueAt: number; transactionHashes: Hex[]; fundingVerified: true; status: 'committed'; createdAt: string; }
export async function assertTestnet(client: ReturnType<typeof createTestReader>) {
  if (await client.getChainId() !== 42431) throw new Error('Refusing operation: the RPC is not Tempo Moderato testnet.');
  if (await client.readContract({ address: PATH_USD, abi: tokenAbi, functionName: 'decimals' }) !== 6) throw new Error('Unexpected test asset precision.');
}
export async function waitForSuccess(client: ReturnType<typeof createTestReader>, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
export function newPaymentId() { return keccak256(toHex(`soleil:earned-invoice:v1:${crypto.randomUUID()}`)); }
export async function createFundedTestCommitment(artifact: VaultArtifact, progress: (step: string) => void = () => {}, rpcUrl = MODERATO_RPC, beneficiary?: string): Promise<FundedCommitment> {
  if (beneficiary && !isAddress(beneficiary)) throw new Error('Enter a valid Tempo receiving address.');
  const employer = createTestWallet(rpcUrl); const recipient = beneficiary as Address | undefined ?? createTestWallet(rpcUrl).account.address; const reader = createTestReader(rpcUrl); const hashes: Hex[] = [];
  progress('Checking the test network and asset'); await assertTestnet(reader);
  progress('Requesting free employer test funds');
  await employer.faucet.fundSync({ account: employer.account.address });
  progress('Deploying immutable company vault');
  const deployHash = await employer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [PATH_USD, employer.account.address, parseUnits('200', 6), '0x0000000000000000000000000000000000000000'] });
  hashes.push(deployHash); const deployReceipt = await waitForSuccess(reader, deployHash); const vault = deployReceipt.contractAddress;
  if (!vault) throw new Error('Deployment did not produce a contract address.');
  const code = await reader.getCode({ address: vault });
  if (!code || !matchesVaultRuntime(code, artifact)) throw new Error('Deployed executable code did not match the compiled vault.');
  progress('Approving and depositing 1,000 test pathUSD');
  hashes.push(await employer.writeContract({ address: PATH_USD, abi: tokenAbi, functionName: 'approve', args: [vault, parseUnits('1000', 6)] })); await waitForSuccess(reader, hashes.at(-1)!);
  hashes.push(await employer.writeContract({ address: vault, abi: artifact.abi, functionName: 'deposit', args: [parseUnits('1000', 6)] })); await waitForSuccess(reader, hashes.at(-1)!);
  const paymentId = newPaymentId(); const block = await reader.getBlock(); const dueAt = Number(block.timestamp);
  progress('Committing a funded 300 pathUSD invoice');
  hashes.push(await employer.writeContract({ address: vault, abi: artifact.abi, functionName: 'commit', args: [paymentId, recipient, parseUnits('300', 6), BigInt(dueAt)] })); await waitForSuccess(reader, hashes.at(-1)!);
  const protectedAmount = await reader.readContract({ address: vault, abi: artifact.abi, functionName: 'committed' });
  const claim = await reader.readContract({ address: vault, abi: artifact.abi, functionName: 'claims', args: [paymentId] }) as [Address, bigint, bigint, boolean];
  const liquid = await reader.readContract({ address: vault, abi: artifact.abi, functionName: 'liquidBalance' }) as bigint;
  if (protectedAmount !== parseUnits('300', 6) || liquid < parseUnits('500', 6) || claim[0].toLowerCase() !== recipient.toLowerCase() || claim[1] !== parseUnits('300', 6) || claim[2] !== BigInt(dueAt) || claim[3]) throw new Error('Fixed commitment or reserve verification failed.');
  return { network: 'Tempo Moderato', chainId: 42431, token: PATH_USD, vault, employer: employer.account.address, recipient, paymentId, amount: '300000000', dueAt, transactionHashes: hashes, fundingVerified: true, status: 'committed', createdAt: new Date().toISOString() };
}
export async function runTestnetProof(artifact: VaultArtifact, progress: (step: string) => void = () => {}, rpcUrl = MODERATO_RPC): Promise<LabEvidence> {
  const funded = await createFundedTestCommitment(artifact, progress, rpcUrl);
  const { vault, recipient, paymentId, dueAt } = funded;
  const hashes = [...funded.transactionHashes]; const caller = createTestWallet(rpcUrl); const reader = createTestReader(rpcUrl);
  progress('Requesting free independent caller test funds');
  await caller.faucet.fundSync({ account: caller.account.address });
  progress('Settling from a different funded caller without the employer signature');
  hashes.push(await caller.writeContract({ address: vault, abi: artifact.abi, functionName: 'pay', args: [paymentId] })); await waitForSuccess(reader, hashes.at(-1)!);
  const recipientBalance = await reader.readContract({ address: PATH_USD, abi: tokenAbi, functionName: 'balanceOf', args: [recipient] });
  const committedAfter = await reader.readContract({ address: vault, abi: artifact.abi, functionName: 'committed' }) as bigint;
  if (recipientBalance !== parseUnits('300', 6) || committedAfter !== 0n) throw new Error('Actual recipient delivery or liability reconciliation failed.');
  const claim = await reader.readContract({ address: vault, abi: artifact.abi, functionName: 'claims', args: [paymentId] }) as [Address, bigint, bigint, boolean];
  if (!claim[3] || claim[0].toLowerCase() !== recipient.toLowerCase()) throw new Error('Claim state verification failed.');
  progress('Verifying duplicate claim rejection'); let duplicateRejected = false;
  try { await reader.simulateContract({ account: caller.account, address: vault, abi: artifact.abi, functionName: 'pay', args: [paymentId] }); }
  catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'AlreadyPaid') duplicateRejected = true;
    else throw error;
  }
  if (!duplicateRejected) throw new Error('Duplicate claim was not rejected.');
  return { network: 'Tempo Moderato', chainId: 42431, token: PATH_USD, vault, employer: funded.employer, recipient, caller: caller.account.address, paymentId, amount: '300000000', dueAt, transactionHashes: hashes, verified: true, recipientBalance: recipientBalance.toString(), committedAfter: committedAfter.toString(), createdAt: new Date().toISOString() } satisfies LabEvidence;
}
