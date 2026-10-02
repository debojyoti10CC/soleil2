import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../src/lib/display';
describe('exact payment presentation', () => {
  it('never displays a positive micro-unit payment as zero', () => {
    expect(formatMoney('1')).toBe('$0.000001');
    expect(formatMoney('1234567')).toBe('$1.234567');
    expect(formatMoney('1000000')).toBe('$1.00');
    expect(formatMoney('10000')).toBe('$0.01');
    expect(formatMoney('1000000000000000000000001')).toBe('$1,000,000,000,000,000,000.000001');
  });
  it('converts the smallest asset unit exactly and rejects ambiguous or excessive precision', () => {
    expect(parseMoney('0.000001')).toBe('1');
    expect(parseMoney('1234.567891')).toBe('1234567891');
    for (const value of ['0', '-1', '1e3', '0.0000001', '1,000.00']) expect(() => parseMoney(value)).toThrow();
  });
});
