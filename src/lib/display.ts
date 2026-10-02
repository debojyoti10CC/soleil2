import type { Amount } from '../shared/types';
export function formatMoney(value: Amount, decimals = 6, symbol = '$'): string {
  const n = BigInt(value || '0'), unit = 10n ** BigInt(decimals), negative = n < 0n, a = negative ? -n : n;
  const fraction = (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '−' : ''}${symbol}${(a / unit).toLocaleString('en-US')}.${fraction}`;
}
export function parseMoney(value: string): Amount {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw new Error('Enter a positive amount with up to 6 decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');
  return amount.toString();
}
export function sumMoney(values: string[]): string { return values.reduce((sum, value) => sum + BigInt(value || '0'), 0n).toString(); }
export function shortAddress(value: string): string { return value.length > 18 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value; }
export function humanize(value: string): string { return value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }
export function dateLabel(value: string): string { return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
export function localDateInput(value: string): string { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); }

