export type Rail = 'solana' | 'tempo';
export type UserRole = 'owner' | 'worker';
export type Amount = string;
export interface User { id: string; name: string; email: string; role: UserRole; organizationId: string; workerId?: string; }
export interface Company { id: string; name: string; jurisdiction: string; entityType: string; formationStatus: string; taxIdStatus: string; verificationStatus: string; bankingStatus: string; paymentsStatus: string; formationProvider?: string; }
export interface Vault { id: string; rail: Rail; asset: string; decimals: number; address: string; balance: Amount; committed: Amount; buffer: Amount; surplus: Amount; strategyPrincipal: Amount; strategyValue: Amount; riskMode: 'normal' | 'protected'; retired: boolean; settlementAvailable: boolean; }
export interface Worker { id: string; name: string; email: string; address: string; rail: Rail; confirmed: boolean; blocked: boolean; received: Amount; managedTestWallet?: boolean; confirmationProof?: string; }
export type InvoiceStatus = 'draft' | 'approved' | 'committed' | 'paid';
export interface Invoice { id: string; number: string; workerId: string; description: string; amount: Amount; rail: Rail; dueAt: string; status: InvoiceStatus; paymentId?: string; transactionRef?: string; createdAt: string; paidAt?: string; commitTransactionRef?: string; nativePending?: { operation: string; hash?: string; status: 'submitted' | 'uncertain' }; }
export interface Activity { id: string; type: string; title: string; detail: string; createdAt: string; rail?: Rail; actor: string; }
export interface LedgerEntry { id: string; createdAt: string; account: string; debit: Amount; credit: Amount; rail: Rail; reference: string; }
export interface Session { user: User; csrfToken: string; demoEnabled: boolean; }
export interface NativeStatus { network: string; chainId: number; status: 'live' | 'stale' | 'unavailable'; checkedAt?: string; blockNumber?: string; warning?: string; executor: 'managed-test-wallet'; employerAddress: string; callerAddress: string; }
export interface Snapshot { user: User; company: Company; vaults: Vault[]; workers: Worker[]; invoices: Invoice[]; activities: Activity[]; now: string; mode: 'demo' | 'testnet'; native?: NativeStatus; }
export interface Receipt { version: string; mode: 'demo' | 'testnet'; invoiceId: string; paymentId: string; rail: Rail; asset: string; amount: Amount; decimals: number; recipient: string; vault: string; dueAt: string; status: string; transactionRef: string; statement: string; chainId?: number; tokenAddress?: string; explorerUrl?: string; commitTransactionRef?: string; checkedAt?: string; }
export interface PublicConfig { demoEnabled: boolean; bridgeConfigured: boolean; presentationEnabled?: boolean; presentationReady?: boolean; solana: { rpcUrl: string; programId: string | null; mint: string | null }; tempo: { rpcUrl: string; chainId: number; vaultAddress: string | null; tokenAddress: string | null }; }
