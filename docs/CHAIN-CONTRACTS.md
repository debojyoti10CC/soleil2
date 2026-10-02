# Native chain vaults

Soleil's persisted local application ledger is an explicitly labelled simulation. These sources are separate native vaults. The browser's Tempo Testnet Lab uses compiled Solidity and real Moderato transactions; it does not turn local invoices into chain-backed commitments. No real yield or bridge is integrated.

## Shared money and authority rules

Amounts are integer base units with six decimals. L is the selected token balance actually held in the vault; P is committed unpaid principal; B is the fixed buffer. New commitments require L >= P + amount + B. Company withdrawals and allocations preserve P+B. Mature worker settlement requires L >= P, so buffer deficiency does not block an otherwise fully covered worker, while principal deficiency blocks every claim until recapitalization.

The employer fixes an opaque payment ID, canonical beneficiary, amount and due timestamp once. IDs and paid records remain consumed permanently. No cancellation, redirection, arbitrary execution, upgrade method or liability deletion is exposed. Anyone can submit due settlement; caller funding or independent sponsorship pays transaction fees. A keeper is still needed for unattended scheduling. This is not a promise of token spendability: issuer pauses, freezes, denials, burns and network failure remain external risks.

Retirement requires P=0 and permanently prevents future commitments. It releases the buffer for company withdrawal without deleting consumed records. New deposits and fixed-adapter recovery are allowed during shortfall and after retirement. A recovery inflow is never rejected merely because full coverage has not yet been restored.

## Tempo contract

Source: contracts/SoleilVault.sol. Constructor: (token, employer, buffer, fixedStrategy). Use zero strategy for the real testnet payment proof. It validates six decimals without requiring token.code.length because TIP-20 is a native precompile. There is no proxy or delegatecall.

Public operations: deposit(amount), commit(id,beneficiary,amount,due), commitMany(ids,beneficiaries,amounts,dues), pay(id), payMany(ids), withdrawSurplus(amount), allocateSurplus(amount), recoverStrategy(requested,minimumReceived), retire(). Batches have at most 32 elements and revert atomically. A denied worker in one batch does not prevent another worker's individual pay(id).

The official native TIP-20 ABI has transferWithMemo(address,uint256,bytes32) with no return value. Settlement uses this method with the opaque payment ID as memo. It reads source and literal beneficiary balances within the transaction and requires exactly the requested debit AND exactly the requested credit. A nominally successful receive-policy redirect therefore reverts the entire transaction and restores both liability and principal. Zero, TIP-20 addresses, the ReceivePolicyGuard and TIP-1022 virtual forwarding aliases are rejected as canonical beneficiaries. Ordinary contract wallets remain supported; recipient code length is not identity verification.

All mutation paths use a reentrancy guard. deposit checks two-sided exact token deltas. Outgoing methods verify exact delivery. Selected assets with rebasing, transfer fees or nonstandard balances are unsupported.

Optional allocation calls only the immutable selected adapter. It grants exactly the allocation amount and clears the allowance in the same transaction. Adapter value, receipt assets and pending redemptions never count in L. contracts/MockSurplusStrategy.sol is a test stress adapter, not a production yield venue. MockTIP20.sol is a test token that models denial, redirect, pause, issuer burn, transfer fees and hostile callbacks; its setters are deliberately unrestricted and must never represent a real stablecoin.

Run npm run contracts:compile. Artifacts are written to contracts/artifacts/*.json and the vault artifact is also copied to public/contracts/SoleilVault.json for the browser. ABI, creation bytecode, runtime bytecode, compiler version, EVM target and immutableReferences are included. Runtime verification must mask only the compiler's immutable reference ranges and independently read the expected token/employer/buffer/strategy. Merely matching an ABI is not verification. Optimizer runs=200, EVM target Paris, installed solc 0.8.36.

Run npx vitest run contracts/SoleilVault.test.ts. Twelve executable EVM checks passed against local ephemeral EVM accounts: principal/buffer coverage, employer authorization, due time, permissionless delivery, ReceivePolicyGuard rollback, denial batch rollback and individual claims, duplicate/replayed IDs, principal-loss freeze, partial recapitalization, isolated strategy delay/loss, allowance cleanup, partial strategy recovery, retirement, virtual-address rejection, fee rejection and callback reentrancy. These checks are not an audit.

## Solana native program

Source: programs/soleil/src/lib.rs. It uses actual classic SPL Token TransferChecked CPI, validates the mint and six decimals, and rejects Token-2022 or native SOL token accounts. Token source is a PDA-owned token account at the canonical Soleil token PDA; it must have no delegate or close authority. Beneficiaries receive into the canonical classic-token ATA owned by the fixed beneficiary. That ATA must already exist, or the submitting transaction must create it with a separate explicit rent payer before invoking pay. The program never changes a token authority, grants a delegate, closes a vault or closes paid claim records.

PDA seeds, followed by canonical bump:
- Vault: UTF-8 soleil-v1, employer public key, mint public key, 32-byte vault ID.
- Token account: UTF-8 soleil-token, vault public key.
- Claim: UTF-8 soleil-claim, vault public key, 32-byte payment ID.
A pre-funded unused system PDA is safely funded/allocated/assigned, so lamport dust cannot deny initialization. An existing owned/data-bearing account is never reinitialized.

Instruction payloads start with one unsigned byte. All integers are little endian and exact data lengths are enforced.

| Tag | Payload after tag | Accounts in order |
| --- | --- | --- |
| 0 initialize | vaultId[32], buffer u64 | employer signer+writable; vault writable; tokenPDA writable; mint; Token program; System program |
| 1 deposit | amount u64 | depositor signer; vault; tokenPDA writable; source token writable; mint; Token program |
| 2 commit | paymentId[32], beneficiary publickey[32], amount u64, due unix i64 | employer signer+writable; vault writable; tokenPDA; claim writable; mint; Token program; System program |
| 3 pay | paymentId[32] | vault writable; tokenPDA writable; claim writable; fixed worker ATA writable; mint; Token program |
| 4 withdraw | amount u64 | employer signer; vault; tokenPDA writable; employer ATA writable; mint; Token program |
| 5 retire | none | employer signer; vault writable |
| 6 payMany | count u8, paymentIds[32] repeated count | vault writable; tokenPDA writable; mint; Token program; claim writable + fixed worker ATA writable pairs |

No beneficiary or employer signer is needed for tag3 or tag6: the transaction's independently funded fee payer signs, while the program signs only for its own canonical vault PDA. Native atomic transaction rollback protects batches; maximum count16 and actual transaction account/byte/compute limits may impose a smaller practical count. Splitting into multiple transactions loses global atomicity.

Vault state is 122 bytes: magic SOLVAU01[8], employer[32], mint[32], vaultId[32], buffer u64, committed u64, retired u8, canonical bump u8. Claim state is also 122 bytes: magic SOLCLM01[8], vault[32], paymentId[32], beneficiary[32], amount u64, due i64, paid u8, canonical bump u8. Booleans must be 0 or1. These fields and versions are stable byte-level contracts for clients.

Cargo dependencies are pinned by programs/soleil/Cargo.lock; cargo test --manifest-path programs/soleil/Cargo.toml runs host tests. The native CPI tests use a narrowly scoped syscall adapter to execute the real SPL Token processor and validate the program's PDA seeds. This is deeper than a ledger mock but is not an SBF validator and does not prove transaction rollback, account creation or deployment.

Host Rust compilation was first blocked by Windows Application Control while executing a dependency build script. The installed Ubuntu-22.04 Rust/Solana toolchains are the authorized fallback; no Windows protection setting was changed. The final Solana host/SBF/deployment status is recorded below after running the gates. Production deployment must revoke its upgrade authority; until then, source-level absence of upgrade methods does not make an upgradeable Solana deployment immutable.

## Official protocol references

- [Tempo networks and Moderato chain 42431](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/quickstart/connection-details.mdx)
- [TIP-20 native interface and six decimals](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/protocol/tip20/spec.mdx)
- [TIP-403 receive-policy redirection](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/protocol/tip403/receive-policies.mdx)
- [TIP-1022 virtual address format and literal balance semantics](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1022.md)
- [Official Moderato test faucet](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/quickstart/faucet.mdx)
- [Solana program crate and on-chain versus host targets](https://docs.rs/solana-program/2.3.0/solana_program/)
- [Classic SPL Token source](https://github.com/solana-program/token)


## Verification actually completed

- Solidity compilation passed with solc 0.8.36, optimizer 200 and Paris EVM target; ABI/bytecode/runtime/immutable metadata artifacts are available. The 12 invariant cases passed against an isolated local EVM; the root application owns the final chosen EVM test harness.
- Rust host compilation and eight tests passed using Ubuntu-22.04's existing Rust toolchain. The CPI host fixture invokes the actual classic SPL Token processor and checks canonical signer seeds.
- The actual deployable SBF build passed using cargo-build-sbf 4.1.0, platform-tools 1.54. programs/soleil/deploy/soleil_vault.so is 111,512 bytes.
- The actual SBF program was preloaded with upgrades disabled on an isolated Solana test validator 4.2.2 at http://127.0.0.1:19099. Twenty-one checks passed across 12 confirmed local transactions. This includes actual account creation with safely prefunded system PDAs, fixed-recipient TransferChecked CPI, real atomic batch rollback when the second worker is frozen, individual permissionless claim by an independent fee payer, replay/consumed-ID/withdrawal/retirement gates and full company buffer recovery.
- The proof client passed its independent strict TypeScript check. All proof signers were generated in memory, and only public evidence is saved.
- Solana DEVNET deployment did not happen: the official free faucet rate-limited both 2-SOL and 1-SOL requests for a fresh isolated signer. Local evidence is explicitly marked local-validator/localnet. No existing user wallet or funds were used. Tempo's separate real Moderato testnet proof is maintained by the application's testnet integration and must be assessed independently.
- No security audit or mainnet deployment has been performed. Mock surplus yield stays explicitly simulated.

The published public evidence is public/solana-testnet-evidence.json. Its program ID identifies the local genesis SBF program, not a devnet deployment. Transaction signatures are local and must not be linked to devnet/mainnet explorers. Worker balances, paid tombstones and zero final liability were read from real local validator accounts. A source/binary hash and all check labels are included.

## Reproduce the native Solana proof

Requires npm dependencies plus an installed Linux/WSL Rust and Solana/Agave CLI toolchain. The app itself does not require these tools merely to run its labelled local demo. On this host the existing tools were /home/debu/.cargo/bin and /home/debu/.local/share/solana/install/active_release/bin; no toolchain installation or Windows policy change was needed.

From an Ubuntu/WSL shell, replacing the project path if it differs:

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "/mnt/c/Users/Debojyoti De Majumde/Downloads/soleil2"
cargo test --manifest-path programs/soleil/Cargo.toml --target-dir /var/tmp/soleil-host-build
cargo-build-sbf --manifest-path programs/soleil/Cargo.toml --sbf-out-dir programs/soleil/deploy
sh programs/soleil/start-local-validator.sh
```

Leave that validator process running. The start script always creates a fresh private ledger, binds the dedicated local RPC port, supplies a synthetic public genesis mint and explicitly preloads this project's SBF binary with upgrades disabled. It does not load or modify an existing wallet, ledger or RPC configuration. If a port is already occupied, resolve that separately; do not stop an unrelated validator. Stop this newly started foreground process with Ctrl+C when done.

From a second terminal in the project folder:

```sh
npx tsx programs/soleil/prove-local.ts
npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck programs/soleil/prove-local.ts
```

The proof permits only loopback RPC hosts. It creates a new six-decimal classic SPL test mint and two workers, obtains only local faucet SOL, generates signing keys in memory and saves only public proof data. Its successful output names 21 checks, 12 confirmed local transactions and the evidence file. Changing the public local program ID requires setting SOLEIL_SOLANA_PROOF_PROGRAM identically for the validator and proof client.

programs/soleil/deploy-devnet.sh is a separate explicit, opt-in DEVNET deployment helper. It creates new private files under /var/tmp, requests only free devnet faucet SOL, supplies every deployer/program/buffer/authority explicitly and deploys with --final. It never reads a default user wallet. It stops if faucet funding fails, and must never be represented as having deployed just because a planned program ID was printed. The application does not automatically run it.


## Native Solana adapter and public deployment gate

The reusable client is programs/soleil/adapter.ts. It is an instruction builder and confirmed-state reader, not a wallet or transaction relay. The host must supply a signer for privileged employer/depositor operations and a separately funded transaction fee payer for permissionless worker claims. It never reads a default wallet, sends a transaction automatically or substitutes a local ledger for a failed public RPC.

Configuration requires an explicit RPC URL, cluster, genesis hash, program ID, exact compiled SBF SHA-256 and classic six-decimal mint. DEVNET is pinned to genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG. Local-validator mode permits only loopback RPC. Before building instructions or reading state, the adapter verifies the program is executable, checks its loader, rejects an active upgrade authority, hashes the deployed SBF bytes and verifies the selected mint's classic SPL owner, initialization and decimals. An immutable program-data deployment must be allocated to exactly the compiled binary length; extra allocation padding deliberately causes the exact hash comparison to fail. A legacy immutable loader is accepted only for the explicitly local proof.

Vault and claim addresses are derived from canonical seeds. A coherent getMultipleAccounts response reads the vault, token PDA, selected mint, native Clock and requested claims at one response context slot. The adapter validates exact state versions, lengths, ownership, IDs, canonical bumps, mint and authority; vault token delegates, close authority and native-SOL token state are rejected. It reports a frozen token account and issuer freeze authority as operational constraints. Due eligibility uses the observed native Clock unix_timestamp, not the user's computer clock. The transaction itself still decides whether a payment is due.

Snapshots contain mode, cluster, checkedAt, slot, blockTime, actualMint, vault, vaultTokenAccount, L/P/B, reserve coverage, surplus and immutable claim fields. Numeric token amounts and timestamps are decimal strings. Snapshot blockTime is the Clock timestamp included in that response. rpcOrigin omits any RPC path/query credential. No transaction hash is invented by the builder. The host records the actual submitted signature and verifies confirmed native state before calling an invoice committed or paid.

Persist a vault ID and payment ID before submission. On a timeout or reload, derive and read the claim PDA before retrying: the permanent consumed-ID record is the recovery source of truth. A confirmed paid claim must match the intended vault, ID, beneficiary, amount and due time. The host should persist commit/pay signatures, actual mint, program and vault with the invoice. Do not overwrite a pending operation with a new payment ID. Never mark an RPC timeout, wrong-cluster response or arbitrary failed transaction as a successful replay rejection. Claims whose recipient ATA is missing require an explicit, idempotent ATA creation instruction and a visible rent payer; a frozen ATA requires issuer action and has no employer redirection or refund escape.

The adapter-only security check script is programs/soleil/adapter-check.ts. It uses an isolated RPC fixture to test verification boundaries, not to claim a real payment. Fourteen checks passed: exact artifact verification, native snapshot decoding and unsigned fixed-recipient pay instructions; wrong genesis/hash, mutable upgrade authority, foreign mint, noncanonical vault bump, delegated vault tokens, foreign/malformed claims and frozen token reporting. This is separate from the actual SBF local-validator proof. Run:

    npx tsx programs/soleil/adapter-check.ts
    npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck programs/soleil/adapter.ts programs/soleil/adapter-check.ts

SOLEIL_SBF_ARTIFACT may point to the exact compiled .so when running a copied draft check from another directory. Otherwise the check reads ./deploy/soleil_vault.so relative to its own source.

### Public devnet status and funding

Public Solana DEVNET deployment has not occurred. A single bounded 0.1-SOL CLI retry for the new isolated deployment signer also failed with the generic CLI message that an airdrop request failed and rate limits can cause it. This does not establish a measured HTTP 429 response. Read-only RPC verified the official devnet genesis. DNS returned IPv4 and IPv4-mapped IPv6; no distinct native IPv6 route was available. No proxy rotation, anti-abuse bypass or existing user wallet was used.

The new deployment funding address is 7whjovxbfYbgXvUsQnKKREgLfhx2quHFKxqRfqBQRSUf. Its isolated private test keys remain outside the repository under /var/tmp/soleil-public-devnet.m4LnDY, mode 600. The planned program is 7T392veAG3VMrQ1xFRvk8UP7hph7mVYjKx5g1U38RgmK, which is NOT deployed and must not be shown as live. Only public addresses may appear in application evidence.

The official Foundation faucet identifies a human GitHub sign-in option for higher limits and tells AI agents to use CLI or proof of work. The officially linked devnet-pow client requires at least 5,000 starter lamports for a transaction and attempts the same CLI airdrop when empty; it cannot bootstrap this zero-SOL signer. QuickNode's published FAQ says the base faucet needs no account or mainnet balance, but its actual current UI rejected this fresh signer with a mainnet-balance requirement. No mainnet funds were supplied or borrowed to pass that gate. Repeated faucet requests have stopped.

A human may approve their own GitHub sign-in at the official Foundation faucet and request only free DEVNET SOL for that exact fresh address. No agent takeover of GitHub credentials is authorized. Deployment needs enough devnet SOL for both temporary upload-buffer and permanent program-data rent plus transactions (about 1.6 SOL for the recorded 111,512-byte binary, with a safety margin). After funding, reuse the same fresh deployment directory, explicit program/buffer/deployer key files, explicit devnet RPC and final/immutable deployment. Confirm executable ownership, authority=None and exact SBF bytes before publishing a devnet configuration.

A stronger public asset proof should use Circle's actual DEVNET USDC mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU and its official public test-USDC faucet after native SOL funding. Verify its live classic-token owner and six decimals first. Twenty faucet test-USDC can fund a small real invoice commitment and fixed-worker payment; issuer-controlled freeze behavior cannot be manufactured by the application. Test-USDC has no financial value and is not production backed USDC. This planned proof is not completed, and the locally created test mint must remain labelled local.

Primary references:
- https://faucet.solana.com/
- https://solana.com/developers/cookbook/development/airdrops-and-faucets
- https://github.com/jarry-xiao/proof-of-work-faucet
- https://github.com/jarry-xiao/proof-of-work-faucet/blob/main/cli/src/main.rs
- https://faucet.quicknode.com/solana/devnet
- https://faucet.circle.com/
- https://developers.circle.com/stablecoins/usdc-contract-addresses


