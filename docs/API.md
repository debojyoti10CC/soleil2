# Local API

The API is under `/api`. JSON responses use the shared types in `src/shared/types.ts`; errors normally have `{ "error": "message", "code": "CODE" }`. The ledger endpoint returns CSV and logout returns HTTP 204.

With `SOLEIL_NATIVE_ENABLED=true`, the presentation workspace uses **actual Tempo Moderato testnet transactions**, chain ID `42431`, and six-decimal test pathUSD. The local server holds encrypted, generated employer, independent caller and receiving keys. These are isolated test wallets; the API cannot import user keys. Test assets have no economic value. The explicitly enabled accounting simulation is a separate organization with `mode: 'demo'` and `sim_` references.

## Authentication and request headers

All POST requests require an allowed `Origin`. Auth initiation uses this check without a prior session. Workspace mutations require the HttpOnly session cookie and `x-csrf-token` from the returned `Session`; fetch with `credentials: 'same-origin'`. Native wallet/provisioning actions additionally require a loopback connection and loopback application origin. A missing/expired session returns 401; wrong permissions, Origin or CSRF return 403.

The browser helper `src/lib/api.ts` sends the session's CSRF token and manages operation keys. Call `setSession(session)` after authentication and `setSession(null)` after logout. State responses are `Snapshot`s with `mode: 'testnet'` for native companies and `mode: 'demo'` for accounting simulations. Inspect `state.native.status` before native actions.

```ts
import { api, setSession } from './src/lib/api';
import type { Session, Snapshot } from './src/shared/types';

const session = await api<Session>('/auth/presentation', {
  method: 'POST', body: { role: 'owner' },
});
setSession(session);
const state = await api<Snapshot>('/bootstrap');
```

Run `npm run presentation:prepare` before that example. Presentation login reads a prepared local bundle; it never requests faucet funding or deploys a contract. Ordinary registration creates a native company with no vault or credited funds when the adapter is enabled; the owner explicitly provisions it afterward. Without the adapter, registration creates an empty accounting simulation. Regular registration is:

```json
POST /api/auth/register
{"name":"Example Owner","email":"owner@example.test","password":"replace-with-a-strong-password","companyName":"Example Studio"}
```

Passwords must contain 8–128 characters. Sessions last 12 hours. No email is sent. The `@soleil.local` domain is reserved for seeded local identities.

| Method and path | Input / result |
|---|---|
| `GET /health` | Public `{ok:true, service:'soleil', mode:'native-testnet'|'local-simulation'}`; launchers should check the service identity. |
| `GET /config` | Public flags, including `presentationEnabled` and `presentationReady`; no secrets. `bridgeConfigured` remains false. |
| `GET /auth/session` | Current `Session`, or 401. |
| `POST /auth/presentation` | `{role:'owner'|'worker'}` → `Session`; prepared native bundle and local connection/origin required. |
| `POST /auth/demo` | `{role:'owner'|'worker'}` → `Session`; enabled only explicitly. |
| `POST /auth/register` | `{name,email,password,companyName}` → new owner `Session`. |
| `POST /auth/login` | `{email,password}` → `Session`. |
| `POST /auth/logout` | Revokes the current session; requires CSRF; returns 204. |
| `GET /auth/invitation?token=...` | Unexpired invitation details: name, email, companyName, address, rail. Treat the URL as a secret. |
| `POST /auth/register-worker` | `{name,email,password,invitationToken}` → worker `Session`; assigned email and one-time token required. |

## Precision and retries

Amounts are **positive integer strings in base units**, not decimal dollars. Assets have six decimals: `"250000000"` means 250 test pathUSD or 250 demo units, depending on the workspace. Per-operation/vault amounts are bounded to unsigned 128-bit range. Simulation lifetime totals can exceed that per-vault bound without losing precision. The native worker `received` field reflects the verified test-token balance of that assigned wallet. Native rail is currently `tempo` only. Due dates are ISO timestamps with a timezone, for example `2026-12-01T12:00:00Z`; native claim maturity uses chain block time and seconds.

Send `x-idempotency-key` with a distinct intent, and reuse that key after an ambiguous response. **Native financial operations require it.** Keys are scoped per authenticated user and bind the method, path and serialized JSON body; query parameters do not change mutation effects. Conflicting reuse returns 409 `IDEMPOTENCY_CONFLICT`. Successful retries return the current snapshot. Simulation/metadata mutation keys expire after 30 days; failed authorization/domain checks do not consume a new key. Native financial intents remain durable: validation happens before reserving an intent, but once execution starts its key remains bound to the original request, including uncertain confirmation.

The native adapter saves exact signed bytes and their hash before broadcast, then reconciles the same transaction on refresh/retry/restart. `NATIVE_PENDING` or `NATIVE_OUTCOME_UNKNOWN` requires reconciliation: preserve `data/`, refresh, and retry the original operation key. Pending invoices may expose `nativePending.hash`. A timeout does not establish failure and must not create a replacement transaction. Definitive `NATIVE_REJECTED`/`NATIVE_REVERTED` is distinct from pending confirmation. A confirmed transaction followed by failed refresh can return a stale snapshot; only verified chain fields establish committed/paid status.

Native bootstrap refreshes the vault and known claims from one verified block. `native.status` is `live`, `stale` or `unavailable`; `checkedAt`/`blockNumber` identify the last verified read. On an outage, the API preserves that cache and timestamp, marks it stale, and blocks native writes. Drafts/approvals remain local metadata and do not create funded entitlements.

The helper retains a retry key after a network/server/JSON-read failure for up to 15 minutes in the current browser session. A caller can supply `idempotencyKey` explicitly. After a reload or account switch, reconcile current state before recreating an ambiguous intent. Invitations, formation handoffs and demo reset do not have generic cached-response semantics; invoice commitments and payouts additionally enforce their own status/replay rules.

```ts
const key = crypto.randomUUID();
await api<Snapshot>(`/vaults/${state.vaults[0].id}/deposit`, {
  method: 'POST', body: { amount: '250000000' }, idempotencyKey: key,
});
// If the response is ambiguous, retry the same path/body with the same key.
// Native: actual transfer from the generated employer test wallet, without a faucet call.
// Simulation: explicitly simulated funding. Neither operation deposits fiat.
```

## Company, contractors and invoices

Unless stated otherwise, POST endpoints require an owner and return an updated `Snapshot`.

| Method and path | Input / behavior |
|---|---|
| `GET /bootstrap` | Tenant snapshot. Worker view contains only that worker's records plus aggregate vault coverage. |
| `POST /native/provision` | `{}`. Native owner only; explicitly prepares generated test keys, deployed vault and initial free test funding, then refreshes chain state. Resumable; no user-key input. |
| `POST /company` | At least one of `{name?,jurisdiction?,entityType?}`. Changes records, not legal status. |
| `POST /company/formation` | `{provider:'stablecorp'|'atlas'}` → `{url,statement}`. External handoff only; no filing/approval. |
| `POST /workers` | Native: `{name,email,rail:'tempo',address?:''}` generates an unconfirmed server-controlled test wallet. Nonempty external addresses are rejected until external-wallet confirmation exists. Simulation: `{name,email,address,rail}`. |
| `POST /workers/:id/invitation` | `{}` → `{url}`. Generates/rotates a 72-hour one-time invitation; no email is sent. |
| `POST /workers/:id/confirm` | `{}`. **Matching worker only**. Native: acknowledge disclosed server custody and verify an actual signature from the assigned generated test key. Simulation: explicit demo confirmation. Owner cannot confirm for them. |
| `POST /workers/:id/block` | `{blocked:boolean}`. Simulation restriction scenario only; unavailable in native workspaces. |
| `POST /invoices` | `{workerId,description,amount,dueAt,rail}`. Creates a draft for earned work. |
| `POST /invoices/:id/approve` | `{}`. Draft → approved; not yet funded. |
| `POST /invoices/:id/commit` | `{}`. Native immutable contract claim; confirmed assigned recipient and liquid coverage plus buffer required. Native operation key required. |
| `POST /invoices/:id/pay` | `{}`. Owner or matching worker; committed and due, fixed recipient, all principal covered. Native uses a distinct generated caller key. |
| `POST /invoices/batch/pay` | `{ids:string[]}`. Owner; native 1–32 distinct IDs, simulation 1–50; atomic batch. |
| `GET /receipts/:invoiceId` | Owner/matching worker. Native: fixed payment ID, chain/asset/vault, actual commitment/settlement hashes and explorer link. Simulation: explicit simulation statement and `sim_` reference. |
| `GET /exports/ledger` | Owner CSV; native postings labelled `TEMPO_MODERATO_TESTNET`, simulation postings labelled `LOCAL_SIMULATION`. |

A native flow is: provision company → add managed contractor → copy invitation → worker registers and acknowledges test receiving wallet → owner creates/approves earned invoice → owner commits → worker/owner settles when due → inspect receipt/verifier. Presentation uses a prepared vault and an already approved, due invoice. Use separate browser profiles for both sessions. Native claims cannot be cancelled or reset. The simulation follows the same local metadata sequence with explicitly simulated funding/confirmation. Draft/approved invoices have no funded receipt; invalid batches reject atomically.

Native payment IDs are `keccak256(toHex('soleil:tempo:' + organizationId + ':' + invoiceId))`; recipient/amount/due time must match the immutable chain tuple. A verified paid tuple can precede settlement-event indexing: it shows `paid` but cannot export a receipt (`CHAIN_RECEIPT_UNAVAILABLE`) until its actual settlement hash is available. The API never substitutes a commitment hash for payment. CSV contains workflow postings, not a comprehensive chain or bank ledger; initial preparation funding is not synthesized into entries. Batched settlement references include both transaction hash and payment ID.

## Treasury and demonstration controls

These POST endpoints require an owner. Native financial actions require fresh verified chain state, local origin/connection, CSRF and an operation key; simulation actions require explicit demo configuration. `:id` is the current snapshot's vault ID, not a chain address.

| Path | Input / behavior |
|---|---|
| `/vaults/:id/deposit` | `{amount}`. Native transfer from the generated employer test wallet; simulation adds demo funds. No fiat deposit. |
| `/vaults/:id/withdraw` | `{amount}`. Only liquid surplus above commitments and buffer. |
| `/vaults/:id/allocate` | `{amount}`. Simulation only; no real strategy adapter is enabled. |
| `/vaults/:id/simulate` | `{event:'loss'|'delay'|'recover',amount?}`. Simulation only. Loss requires amount; recovery defaults to remaining simulated value. Strategy value never backs claims. |
| `/vaults/:id/retire` | `{}`. Requires zero commitments; permanently disables new commitments/allocations and releases buffer. Recovery/withdrawal remain available. |
| `/demo/advance` | `{hours:number}`. Seeded demo organization only; positive, at most 8,760 hours per request. Advances local demonstration time, not chain time or session expiry. |
| `/demo/reset` | `{}`. Seeded demo owner only; restores demo records and revokes invited demo users/invitations. Does not reset other organizations or any chain. |

Native workspaces reject simulation clock/reset/restriction/strategy controls. Retirement still requires zero commitments; it permanently disables new claims and releases the active buffer. Common errors include `RECIPIENT_UNCONFIRMED`, `INSUFFICIENT_COVERAGE`, `RESERVE_PROTECTED`, `NOT_DUE`, `RECIPIENT_BLOCKED`, `PRINCIPAL_SHORTFALL`, `INVALID_STATUS`, `VAULT_RETIRED`, `MANAGED_TEST_WALLET_REQUIRED`, `REAL_ACTION_UNAVAILABLE`, `NATIVE_UNAVAILABLE` and recovery codes above. Contract execution remains authoritative if token eligibility changes after a read.

## Tempo testnet RPC

`POST /testnet/rpc` accepts one JSON-RPC 2.0 request and returns the upstream envelope. Explicit native or demo configuration enables it, with one fixed Moderato upstream. Allowed reads support the independent verifier without a Soleil login. All requests still require an allowed Origin; writes additionally require a loopback connection and loopback application origin. The relay accepts signed bytes but no private keys; persistent presentation keys are handled by the separate native adapter.

```json
{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}
```

Allowed reads: `eth_chainId`, `eth_call`, `eth_getCode`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_blockNumber`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_getTransactionCount`, `eth_getBalance`. Allowed local writes: `tempo_fundAddress` with one address, and `eth_sendRawTransaction` with one bounded signed hex transaction. No private-key, arbitrary URL, unrestricted method or batch interface exists.

Limits: 64 KB request, 2 MB response, 15-second upstream deadline, 8 concurrent requests, 240 reads and 30 writes per minute per connection address. Local proxies share that connection quota. Upstream failures return a bounded JSON-RPC error with HTTP 502; permission/validation/rate errors use the regular API error format. See [SECURITY.md](SECURITY.md) for trust boundaries.
