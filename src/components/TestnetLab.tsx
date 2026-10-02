import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, FlaskConical, CheckCircle2, LoaderCircle, ShieldCheck, Download } from 'lucide-react';
import { EXPLORER, runTestnetProof, createFundedTestCommitment, type LabEvidence, type FundedCommitment, type VaultArtifact } from '../lib/tempo-lab';
import './testnet.css';
interface SolanaEvidence { mode: string; cluster: string; verifiedAt: string; programId: string; programSha256: string; checks: { label: string; passed: boolean }[]; final: { workerAReceived: string; workerBReceived: string; committed: string; retired: boolean }; }
export default function TestnetLab() {
  const [evidence, setEvidence] = useState<LabEvidence | null>(null);
  const [solanaEvidence, setSolanaEvidence] = useState<SolanaEvidence | null>(null);
  const [funded, setFunded] = useState<FundedCommitment | null>(null); const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false); const [step, setStep] = useState(''); const [error, setError] = useState('');
  useEffect(() => { fetch('/testnet-evidence.json').then((r) => r.ok ? r.json() : null).then((value) => { if (value?.verified && value.chainId === 42431) setEvidence(value); }).catch(() => {}); }, []);
  useEffect(() => { fetch('/solana-testnet-evidence.json').then(r => r.ok ? r.json() : null).then(value => { if (value?.mode === 'local-validator' && value.checks?.every((check: { passed: boolean }) => check.passed)) setSolanaEvidence(value); }).catch(() => {}); }, []);
  async function run() {
    setError(''); setBusy(true);
    try {
      const response = await fetch('/contracts/SoleilVault.json');
      if (!response.ok) throw new Error('Compile contracts first with npm run contracts:compile.');
      setEvidence(await runTestnetProof(await response.json() as VaultArtifact, setStep, `${window.location.origin}/api/testnet/rpc`));
      setStep('Verified: recipient delivery, zero unpaid liability and duplicate rejection.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test network unavailable. Please retry.'); }
    finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'soleil-testnet-receipt.json'; anchor.click(); URL.revokeObjectURL(url);
  }
  async function createCommitment() {
    setError(''); setBusy(true); setFunded(null);
    try {
      const response = await fetch('/contracts/SoleilVault.json');
      if (!response.ok) throw new Error('Compiled contract metadata is unavailable.');
      setFunded(await createFundedTestCommitment(await response.json() as VaultArtifact, setStep, `${window.location.origin}/api/testnet/rpc`, recipient.trim() || undefined));
      setStep('Funding verified. Open the independent verifier to read or claim.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test network unavailable.'); }
    finally { setBusy(false); }
  }
  function exportCommitment() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(funded, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'soleil-funded-test-commitment.json'; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="testnet-page">
    <div className="testnet-heading"><div><p className="testnet-eyebrow">ON-CHAIN PROOF</p><h1>See the promise work.</h1><p>Real commitments. Real delivery. On Tempo Moderato testnet.</p></div><span className="testnet-network"><FlaskConical size={16}/> Test funds only · 42431</span></div>
    <div className="testnet-hero"><div className="testnet-orb"><ShieldCheck size={38}/></div><div><h2>An independent caller gets the worker paid.</h2><p>This lab creates isolated wallets, uses free faucet funds, deploys an immutable vault, commits a 300 pathUSD invoice, and settles from a different account. It verifies actual recipient delivery and rejects a second claim.</p><p className="testnet-small">No existing wallet or real assets are used. Keys exist only in this tab's memory and are discarded on refresh. Workspace demo balances remain separate.</p><button className="testnet-button" onClick={run} disabled={busy}>{busy ? <LoaderCircle className="testnet-spin" size={18}/> : <FlaskConical size={18}/>} {busy ? 'Running the proof…' : evidence ? 'Run a fresh on-chain proof' : 'Run the on-chain proof'}</button></div></div>
    {step && <div role="status" className="testnet-progress">{busy && <LoaderCircle size={16} className="testnet-spin"/>}{step}</div>}
    {error && <div role="alert" className="testnet-error"><strong>The proof could not finish.</strong><p>{error}</p><p>Public testnet RPC and faucet limits can interrupt a run. This does not change local invoices or create a completed receipt.</p></div>}
    {evidence && <section className="testnet-result"><div className="testnet-result-header"><h2><CheckCircle2 size={21}/> Verified testnet settlement</h2><button onClick={download}><Download size={16}/> Export proof</button></div><div className="testnet-stats"><div><span>Recipient delivered</span><strong>300.00 pathUSD</strong></div><div><span>Unpaid liability after</span><strong>0.00 pathUSD</strong></div><div><span>Payment execution</span><strong>Independent caller</strong></div></div><dl>{([['Vault', evidence.vault], ['Employer', evidence.employer], ['Worker recipient', evidence.recipient], ['Independent caller', evidence.caller]] as const).map(([label, address]) => <div key={label}><dt>{label}</dt><dd><a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">{address}<ArrowUpRight size={14}/></a></dd></div>)}</dl><h3>Transaction trail</h3><ol>{evidence.transactionHashes.map((hash, i) => <li key={hash}><span>{['Deploy vault', 'Authorize deposit', 'Fund vault', 'Commit invoice', 'Independent settlement'][i] ?? 'Transaction'}</span><a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 14)}…{hash.slice(-8)}<ArrowUpRight size={14}/></a></li>)}</ol><p className="testnet-small">Verified {new Date(evidence.createdAt).toLocaleString()}. Test assets have no economic value. Successful tests do not establish an audit or production readiness.</p></section>}
    {evidence && <p><Link className="testnet-button" to={`/verify?vault=${evidence.vault}&paymentId=${evidence.paymentId}`}>Open independent verifier <ArrowUpRight size={16}/></Link></p>}
    <section className="testnet-result"><h2>Create a commitment someone else can claim.</h2><p className="testnet-small">This separate testnet action funds a fixed 300 pathUSD entitlement and leaves it unpaid. Share its verifier link; a different caller can settle it without the employer key. The local workspace invoices remain simulated.</p><form className="verifier-form" onSubmit={event => { event.preventDefault(); void createCommitment(); }}><label>Tempo testnet recipient (optional)<input value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy} placeholder="0x… or leave empty for an isolated test recipient" autoComplete="off" spellCheck={false}/></label><p className="testnet-small">Only free Moderato test tokens are used. An empty field creates an isolated recipient; no existing wallet connection is required.</p><button className="testnet-button" disabled={busy}>Create funded testnet commitment</button></form>{funded && <div role="region" aria-label="Funded native commitment"><h3>Funding and fixed recipient verified</h3><dl><div><dt>Recipient</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{funded.recipient}</code></dd></div><div><dt>Payment ID</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{funded.paymentId}</code></dd></div></dl><p><Link className="testnet-button" to={`/verify?vault=${funded.vault}&paymentId=${funded.paymentId}`}>Verify and claim independently <ArrowUpRight size={16}/></Link></p><button className="testnet-button" onClick={exportCommitment}><Download size={16}/>Export funded commitment</button><p className="testnet-small">This receipt records creation. Read current payment status in the verifier. Free test assets have no economic value.</p></div>}</section>
    <section className="testnet-note"><h3>Solana: actual SBF execution</h3>{solanaEvidence ? <><p>The compiled native program passed {solanaEvidence.checks.length} checks on an isolated local Solana validator. Two fixed recipients received 100 and 150 local test tokens from an independent caller. Frozen-recipient rollback, replay rejection, protected reserves and permanent retirement were exercised.</p><p className="testnet-small">Localnet proof, not a devnet deployment. The official devnet faucet was rate-limited. Workspace Solana balances remain simulated.</p><dl><div><dt>Local program</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{solanaEvidence.programId}</code></dd></div><div><dt>Verified</dt><dd>{new Date(solanaEvidence.verifiedAt).toLocaleString()}</dd></div></dl><details><summary>{solanaEvidence.checks.length} passed execution checks</summary><ul>{solanaEvidence.checks.map(check => <li key={check.label}>{check.label}</li>)}</ul></details><p><a href="/solana-testnet-evidence.json" download="soleil-solana-local-proof.json">Download public Solana proof <Download size={14}/></a></p></> : <p>The project includes the native Rust commitment program and its tests. The native-contract guide documents its build, deployment and authority checks.</p>}</section>
  </div>;
}
