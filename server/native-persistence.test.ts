import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeJournal } from './native-journal.js';
import { TestnetKeystore } from './native-keystore.js';
const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'soleil-test-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('native persistence', () => {
  it('restores the same managed wallet after restart without storing plaintext keys and separates colliding labels', async () => {
    const directory = temporary(); const keys = new TestnetKeystore(directory);
    const first = keys.account('a:b'); const other = keys.account('a_b');
    expect(first.address).not.toBe(other.address);
    const restored = new TestnetKeystore(directory).account('a:b');
    expect(restored.address).toBe(first.address);
    expect(await restored.signMessage({ message: 'persistent managed TESTNET recipient' })).toBe(await first.signMessage({ message: 'persistent managed TESTNET recipient' }));
    for (const path of readdirSync(directory).filter(path => path.endsWith('.wallet'))) {
      const stored = JSON.parse(readFileSync(join(directory, path), 'utf8'));
      expect(Object.keys(stored).sort()).toEqual(['ciphertext', 'iv', 'tag']);
      expect(Buffer.from(stored.ciphertext, 'base64').toString()).not.toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
  it('refuses tampered encrypted identities instead of replacing them', () => {
    const directory = temporary(), keys = new TestnetKeystore(directory); keys.account('worker');
    const path = join(directory, readdirSync(directory).find(path => path.endsWith('.wallet'))!);
    const envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.ciphertext = Buffer.alloc(66).toString('base64'); writeFileSync(path, JSON.stringify(envelope));
    expect(() => keys.account('worker')).toThrow();
  });
  it('keeps signed bytes across restart and refuses a conflicting retry', () => {
    const path = join(temporary(), 'journal.sqlite'); let journal = new NativeJournal(path);
    journal.intent({ key: 'claim:1', orgId: 'org', fingerprint: 'same-payload', wallet: 'caller', state: 'intent' });
    journal.signed('claim:1', '0x123', '0xabcdef'); journal.close(); journal = new NativeJournal(path);
    expect(journal.pending('caller')[0]).toMatchObject({ hash: '0x123', raw: '0xabcdef', state: 'signed' });
    expect(() => journal.intent({ key: 'claim:1', orgId: 'org', fingerprint: 'changed-recipient', wallet: 'caller', state: 'intent' })).toThrow(/conflicts/);
    journal.settled('claim:1', true, '42'); expect(journal.pending('caller')).toHaveLength(0); expect(journal.operation('claim:1')?.blockNumber).toBe('42'); journal.close();
  });
  it('serializes one wallet across processes and allows recovery after an expired lease', () => {
    const path = join(temporary(), 'journal.sqlite'), first = new NativeJournal(path), second = new NativeJournal(path);
    expect(first.lock('wallet', 'one', 0)).toBe(true); expect(second.lock('wallet', 'two', 1000)).toBe(false);
    expect(second.lock('wallet', 'two', 120_001)).toBe(true);
    first.unlock('wallet', 'one'); expect(first.lock('wallet', 'three', 120_002)).toBe(false);
    second.unlock('wallet', 'two'); expect(first.lock('wallet', 'three', 120_003)).toBe(true); first.close(); second.close();
  });
  it('archives a receipt-proven revert before retrying the same immutable operation, and never resets an unknown outcome', () => {
    const journal = new NativeJournal(join(temporary(), 'journal.sqlite'));
    journal.intent({ key: 'pay:fixed-id', orgId: 'org', fingerprint: 'fixed-recipient-and-amount', wallet: 'caller', state: 'intent' });
    journal.signed('pay:fixed-id', '0xreverted', '0xsigned');
    expect(() => journal.retryReverted('pay:fixed-id')).toThrow(/receipt-proven/);
    journal.settled('pay:fixed-id', false, '200'); journal.retryReverted('pay:fixed-id');
    expect(journal.operation('pay:fixed-id')).toMatchObject({ state: 'intent', fingerprint: 'fixed-recipient-and-amount' });
    expect(journal.operation('pay:fixed-id')?.hash).toBeUndefined();
    expect(journal.revertedAttempts('pay:fixed-id')).toEqual([{ hash: '0xreverted', block_number: '200' }]);
    journal.close();
  });
});
