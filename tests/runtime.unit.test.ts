import { describe, expect, it } from 'vitest';
import { matchesVaultRuntime } from '../src/lib/verify-runtime';
describe('independent runtime verification', () => {
  const artifact = { deployedBytecode: '0x6001000000026002' as const, immutableReferences: { '1': [{ start: 2, length: 4 }] } };
  it('ignores only known constructor immutable bytes', () => { expect(matchesVaultRuntime('0x6001abcdefab6002', artifact)).toBe(true); });
  it('rejects changed executable logic', () => { expect(matchesVaultRuntime('0x6002abcdefab6002', artifact)).toBe(false); });
  it('rejects missing code, wrong length and invalid reference bounds', () => { expect(matchesVaultRuntime('0x', artifact)).toBe(false); expect(matchesVaultRuntime('0x6001abcdefab600200', artifact)).toBe(false); expect(matchesVaultRuntime('0x6001abcdefab6002', { ...artifact, immutableReferences: { '1': [{ start: 30, length: 4 }] } })).toBe(false); });
});
