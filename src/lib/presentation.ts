import type { Snapshot, Rail } from '../shared/types';
export const TEMPO_EXPLORER = 'https://explore.testnet.tempo.xyz';
export function isNative(data: Snapshot) { return data.mode === 'testnet'; }
export function nativeBlocked(data: Snapshot) { return isNative(data) && (data.native?.status !== 'live' || data.invoices.some(invoice => !!invoice.nativePending)); }
export function verifierLink(vault: string, paymentId?: string) {
  return /^0x[0-9a-f]{40}$/i.test(vault) && /^0x[0-9a-f]{64}$/i.test(paymentId ?? '') ? `/verify?vault=${encodeURIComponent(vault)}&paymentId=${encodeURIComponent(paymentId!)}` : null;
}
export function transactionLink(hash?: string) { return /^0x[0-9a-f]{64}$/i.test(hash ?? '') ? `${TEMPO_EXPLORER}/tx/${hash}` : null; }
export function addressLink(address?: string) { return /^0x[0-9a-f]{40}$/i.test(address ?? '') ? `${TEMPO_EXPLORER}/address/${address}` : null; }
export function assetLabel(data: Snapshot, rail?: Rail) { return data.vaults.find(vault => !rail || vault.rail === rail)?.asset ?? (isNative(data) ? 'pathUSD' : 'Demo USD'); }
