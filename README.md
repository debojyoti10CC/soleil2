# Soleil

Soleil turns an accepted contractor invoice into a funded onchain payment commitment. The immutable vault fixes the recipient, amount and due time, protects committed principal, and lets anyone execute a matured payment without the employer signing again.

The **Employer presentation** and **Worker presentation** screens use a persistent, funded **Tempo Moderato testnet** vault. Balances come from a verified chain block; commit, payment, deposit and surplus withdrawal execute actual transactions. Test pathUSD has no economic value. Optional **Accounting simulation** is visibly separate and produces `sim_` references.

## Start

Requires Node.js 24 or newer. On this prepared computer, double-click **Start Soleil.cmd** and open http://localhost:3001. On a fresh checkout:

```powershell
npm ci
npm run build
npm run presentation:prepare
./scripts/start-local.ps1 -OpenBrowser
```

Preparation generates isolated test wallets, requests free test assets, deploys and verifies the vault, and deposits presentation funds. Run it before presenting. It is resumable and preserves the same wallet identities, vault and transactions on retry. Normal presentation login/commit/claim never requests faucet funding or deploys a contract.

Use **Stop Soleil.cmd** to stop the launcher-managed server. SQLite application data, encrypted generated wallets, signed transaction journal and logs remain in ignored `data/` and `.runtime/`. On Windows, the encryption master is protected by DPAPI for the current OS user. On other systems it is a permission-restricted key file. Do not delete these directories between rehearsals. They are never committed or included in source exports. These server-held keys are demonstration custody, not external user wallet ownership.

## Present the real flow

1. Choose **Worker presentation**, then acknowledge the managed test recipient if it is unconfirmed. A real signature from its assigned generated key is verified; the interface explains that the local server holds this test key.
2. Choose **Employer presentation** in another browser profile. Inspect the live chain timestamp, actual liquid balance, committed principal and protected buffer.
3. Approve an earned-work invoice and commit it. The contract reserves its exact amount and fixes its recipient and due time. On this prepared computer, the original 300 pathUSD invoice is already committed and due; it can be claimed immediately. Fresh preparation seeds it as approved so you can demonstrate commitment first.
4. In the worker portal, refresh and claim the matured payment. A different, pre-funded caller sends the actual transaction; the employer signature is not used. Keep the independent verifier link as another way to inspect the entitlement.
5. Inspect/download the testnet receipt and open the transaction in the Tempo explorer. Repeating a paid claim cannot transfer funds twice. Create another invoice to rehearse again; native commitments cannot be reset or cancelled.

Before every presentation, run `npm run presentation:check`. It verifies the deployed runtime, fixed asset/employer/no-strategy configuration, reserve coverage, executor fee budgets, and pending transaction journal. No public network can be guaranteed available: if verification fails, the app shows the last verified timestamp, marks the state stale and pauses native writes. Refresh resumes chain reconciliation when the RPC recovers. A saved pending transaction is rebroadcast as the same signed bytes; a timeout never creates a replacement payment.

## Implemented surfaces

| Surface | Behavior |
| --- | --- |
| Employer and worker presentation | Real public Tempo testnet balances, immutable commitments and recipient delivery |
| Treasury | Actual test-asset deposits and surplus withdrawals, protected principal/buffer, permanent retirement |
| Receipts | Real commit/settlement hashes, fixed payment ID, asset/chain/vault, explorer and public verifier links |
| Workspace | Password authentication, private sessions/CSRF, tenant isolation, invitations, invoice approval, activity history and CSV ledger |
| Company readiness | Separate formation, tax, KYB, banking and payment-route status; hosted Stablecorp/Atlas handoff |
| Public verifier | No workspace session required; verifies executable bytecode and immutable claim, reads its native paid state |
| Native lab | Fresh isolated Tempo deployment/commit/settlement experiments, optional receiving address, public proof export |
| Solana program | Compiled native SBF vault, real local-validator token transfers, canonical native client adapter; public devnet deployment remains unfunded |
| Accounting simulation | Explicit offline accounting/risk exercise, including strategy loss/delay; no blockchain claims |

Soleil's public Solana deployment has not completed: the fresh deployer lacks devnet SOL and official faucet requests failed with a generic possible-rate-limit message. The recorded Solana proof is an actual **local validator** execution. It is not public devnet evidence. See `docs/CHAIN-CONTRACTS.md`.

Company formation is a provider handoff. A link does not form an entity, approve KYB, open a bank account or enable cashout. Live fiat payouts and yield strategies need approved integrations. The presentation vault has **no strategy**; it never reports simulated yield. Mainnet or real-money use requires an independent contract and operational review.

## Verify

```powershell
npm run check              # Strict browser/server builds + unit/backend/EVM checks
npm run test:e2e           # Isolated local browser journeys, no RPC required
npm run test:presentation  # Real presentation UI + refresh/retry proof, prepared vault required
npm run presentation:check # Live reserve/executor preflight, no faucet/deployment
npm run test:e2e:native    # Separate public verifier/native lab tests, RPC/faucet required
npm run contracts:compile
npm run solana:proof:check
npm audit
```

For browser tests on a fresh computer: `npx playwright install chromium`. Standard local browser tests use an isolated SQLite database. The presentation test deliberately uses the prepared native vault and spends free test assets. Contract tests exercise exact delivery, restrictions/redirection, reentrancy, atomic batches, maturity, replay protection, reserve coverage and retirement.

`npm run dev` runs the API on 3001 and Vite on 5173. `npm start` runs the compiled server with `.env`; use `.env.example`. The Windows launcher enables testnet presentation and the optional accounting simulation on loopback. Never put keys or provider secrets into browser configuration.

## References

- `docs/PRD.md` and `docs/RESEARCH.md`: researched product/Colosseum positioning
- `docs/ARCHITECTURE.md`: reserve rules and trust boundaries
- `docs/API.md`: authentication, mutations and idempotency
- `docs/CHAIN-CONTRACTS.md`: chain contracts and evidence
- `docs/SECURITY.md`: deployment boundaries
- `public/presentation-evidence.json`: last recorded preparation/preflight, not a substitute for a fresh check
