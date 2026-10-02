import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { Account } from 'viem/tempo';
import type { Hex } from 'viem';

interface Envelope { iv: string; tag: string; ciphertext: string; }
function dpapi(value: Buffer, protect: boolean): Buffer {
  const operation = protect ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,[Text.Encoding]::UTF8.GetBytes('Soleil isolated testnet wallets v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result))`;
  // Secret bytes travel through a private pipe, never command arguments, logs or tool output.
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
  return Buffer.from(output.trim(), 'base64');
}

/** Only freshly generated, server-managed Moderato test wallets. Never imports user keys. */
export class TestnetKeystore {
  private readonly directory: string;
  private readonly master: Buffer;
  constructor(directory: string) {
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const windows = process.platform === 'win32';
    const path = resolve(this.directory, windows ? 'master.dpapi' : 'master.key');
    if (!existsSync(path)) {
      const key = randomBytes(32);
      writeFileSync(path, windows ? dpapi(key, true) : key, { flag: 'wx', mode: 0o600 });
    }
    const stored = readFileSync(path); this.master = windows ? dpapi(stored, false) : stored;
    if (this.master.length !== 32) throw new Error('The isolated testnet keystore is invalid. Preserve it and restore its original owner context.');
  }
  private path(label: string) {
    if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(label)) throw new Error('Invalid test wallet scope.');
    return resolve(this.directory, `${createHash('sha256').update(label).digest('hex')}.wallet`);
  }
  account(label: string) {
    const path = this.path(label);
    if (!existsSync(path)) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.master, iv);
      cipher.setAAD(Buffer.from(label));
      const encrypted = Buffer.concat([cipher.update(generatePrivateKey(), 'utf8'), cipher.final()]);
      const envelope: Envelope = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
      // Atomic exclusive publication: concurrent creators converge on the first saved identity.
      try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { unlinkSync(temporary); }
    }
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Envelope;
    const decipher = createDecipheriv('aes-256-gcm', this.master, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(label)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const privateKey = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8') as Hex;
    if (!/^0x[0-9a-f]{64}$/.test(privateKey)) throw new Error('The isolated test wallet is invalid.');
    return Account.fromSecp256k1(privateKey);
  }
  has(label: string) { return existsSync(this.path(label)); }
}
