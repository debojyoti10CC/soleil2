import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, LoaderCircle, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { formatUnits, isAddress, type Address, type Hex } from 'viem';
import { PATH_USD, EXPLORER, assertTestnet, createTestReader, createTestWallet, waitForSuccess, type VaultArtifact } from '../lib/tempo-lab';
import { matchesVaultRuntime } from '../lib/verify-runtime';
import './testnet.css';
interface VerifiedClaim { beneficiary: Address; amount: bigint; due: number; paid: boolean; liquid: bigint; liabilities: bigint; buffer: bigint; now: number; employer: Address; }
export default function IndependentVerifier() {
  const initial = new URLSearchParams(window.location.search);
  const [vault, setVault] = useState(initial.get('vault') ?? ''); const [paymentId, setPaymentId] = useState(initial.get('paymentId') ?? '');
  const [claim, setClaim] = useState<VerifiedClaim | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const rpcUrl = `${window.location.origin}/api/testnet/rpc`;
  async function read() {
    if (!isAddress(vault) || !/^0x[0-9a-f]{64}$/i.test(paymentId)) throw new Error('Enter a valid vault address and 32-byte payment ID.');
    const reader = createTestReader(rpcUrl); await assertTestnet(reader);
    const response = await fetch('/contracts/SoleilVault.json'); if (!response.ok) throw new Error('Vault verification artifact is unavailable.');
    const artifact = await response.json() as VaultArtifact;
    const code = await reader.getCode({ address: vault as Address });
    if (!code || !matchesVaultRuntime(code, artifact)) throw new Error('Unrecognized vault code. This address does not match Soleil’s compiled immutable vault.');
    const token = await reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'token' }) as Address;
    const strategy = await reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'strategy' }) as Address;
    if (token.toLowerCase() !== PATH_USD.toLowerCase() || strategy !== '0x0000000000000000000000000000000000000000') throw new Error('This verifier supports the test pathUSD vault without a strategy only.');
    const [result, liquid, liabilities, buffer, employer, block] = await Promise.all([
      reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'claims', args: [paymentId as Hex] }),
      reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'liquidBalance' }),
      reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'committed' }),
      reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'buffer' }),
      reader.readContract({ address: vault as Address, abi: artifact.abi, functionName: 'employer' }), reader.getBlock(),
    ]);
    const tuple = result as [Address, bigint, bigint, boolean]; if (tuple[1] <= 0n) throw new Error('No commitment exists for this payment ID.');
    setClaim({ beneficiary: tuple[0], amount: tuple[1], due: Number(tuple[2]), paid: tuple[3], liquid: liquid as bigint, liabilities: liabilities as bigint, buffer: buffer as bigint, employer: employer as Address, now: Number(block.timestamp) });
    return { reader, artifact };
  }
  async function verify() { setBusy(true); setError(''); setMessage(''); setClaim(null); try { await read(); } catch (e) { setError(e instanceof Error ? e.message : 'Verification failed.'); } finally { setBusy(false); } }
  async function settle() {
    setBusy(true); setError(''); setMessage('Requesting free caller funds and submitting the fixed-recipient claim…');
    try { const { reader, artifact } = await read(); const caller = createTestWallet(rpcUrl); await caller.faucet.fundSync({ account: caller.account.address }); const hash = await caller.writeContract({ address: vault as Address, abi: artifact.abi, functionName: 'pay', args: [paymentId as Hex] }); await waitForSuccess(reader, hash); await read(); setMessage(`Confirmed on Tempo Moderato: ${hash}`); } catch (e) { setError(e instanceof Error ? e.message : 'Claim failed; check authoritative state before retrying.'); setMessage(''); } finally { setBusy(false); }
  }
  return <main className="testnet-page" style={{ padding: '40px 24px' }}><Link to="/" className="brand brand-link"><img className="brand-image" src="/assets/soleil-logo.png" alt="" width="44" height="44" /><span>soleil<span className="brand-period">.</span></span></Link><div className="testnet-heading" style={{ marginTop: 40 }}><div><p className="testnet-eyebrow">INDEPENDENT VERIFIER</p><h1>Your invoice. Your evidence.</h1><p>No workspace login or employer executor is required.</p></div><ShieldCheck size={38}/></div><section className="testnet-result"><h2>Verify a Tempo testnet commitment</h2><p className="testnet-small">Reads native chain state and checks the deployed runtime against the compiled Soleil vault. This is testnet verification, not a security audit. Token restrictions and network availability remain separate risks.</p><form onSubmit={(event) => { event.preventDefault(); void verify(); }} className="verifier-form"><label>Vault address<input disabled={busy} value={vault} onChange={(e) => { setVault(e.target.value); setClaim(null); }} placeholder="0x…" required/></label><label>Payment ID<input disabled={busy} value={paymentId} onChange={(e) => { setPaymentId(e.target.value); setClaim(null); }} placeholder="0x… (32 bytes)" required/></label><button className="testnet-button" disabled={busy}>{busy ? <LoaderCircle className="testnet-spin" size={17}/> : <ShieldCheck size={17}/>} Verify commitment</button></form></section>{error && <div className="testnet-error" role="alert">{error}</div>}{message && <div className="testnet-progress" role="status">{message}</div>}{claim && <section className="testnet-result"><h2><CheckCircle2 size={20}/> Compiled vault code matched</h2><div className="testnet-stats"><div><span>Committed amount</span><strong>{formatUnits(claim.amount, 6)} pathUSD</strong></div><div><span>Status</span><strong>{claim.paid ? 'Settled' : claim.now >= claim.due ? 'Due' : 'Not due yet'}</strong></div><div><span>Nominal principal coverage</span><strong>{claim.liquid >= claim.liabilities ? 'Covered' : 'Shortfall'}</strong></div></div><dl><div><dt>Fixed beneficiary</dt><dd><a href={`${EXPLORER}/address/${claim.beneficiary}`} target="_blank" rel="noreferrer">{claim.beneficiary}<ArrowUpRight size={14}/></a></dd></div><div><dt>Due time</dt><dd>{new Date(claim.due * 1000).toLocaleString()}</dd></div><div><dt>Liquid balance</dt><dd>{formatUnits(claim.liquid, 6)} pathUSD</dd></div><div><dt>All unpaid commitments</dt><dd>{formatUnits(claim.liabilities, 6)} pathUSD</dd></div></dl>{!claim.paid && <button className="testnet-button" onClick={settle} disabled={busy || claim.now < claim.due || claim.liquid < claim.liabilities}>Settle to fixed recipient</button>}<p className="testnet-small">An isolated caller uses free test funds. Settlement can only send to the contract's fixed beneficiary. No employer signing key is requested or used.</p></section>}</main>;
}
