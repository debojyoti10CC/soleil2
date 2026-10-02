import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export interface NativeOperation { key: string; orgId: string; fingerprint: string; wallet: string; state: 'intent' | 'signed' | 'confirmed' | 'reverted'; hash?: string; raw?: string; blockNumber?: string; }
/** Signed bytes and stable identity are saved before any external broadcast. */
export class NativeJournal {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, org_id TEXT NOT NULL, fingerprint TEXT NOT NULL, wallet TEXT NOT NULL, state TEXT NOT NULL, hash TEXT, raw TEXT, block_number TEXT);
      CREATE TABLE IF NOT EXISTS locks (wallet TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS reverted_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL, block_number TEXT NOT NULL)');
  }
  close() { this.db.close(); }
  get<T>(key: string): T | null { const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : null; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  operation(key: string): NativeOperation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key) as { key: string; org_id: string; fingerprint: string; wallet: string; state: NativeOperation['state']; hash: string | null; raw: string | null; block_number: string | null } | undefined;
    return row ? { key: row.key, orgId: row.org_id, fingerprint: row.fingerprint, wallet: row.wallet, state: row.state, hash: row.hash ?? undefined, raw: row.raw ?? undefined, blockNumber: row.block_number ?? undefined } : null;
  }
  intent(value: NativeOperation) {
    const previous = this.operation(value.key);
    if (previous && previous.fingerprint !== value.fingerprint) throw new Error('Native operation key conflicts with another transaction.');
    if (!previous) this.db.prepare('INSERT INTO operations(key,org_id,fingerprint,wallet,state) VALUES(?,?,?,?,?)').run(value.key, value.orgId, value.fingerprint, value.wallet, 'intent');
    return previous ?? value;
  }
  signed(key: string, hash: string, raw: string) { this.db.prepare("UPDATE operations SET state='signed', hash=?, raw=? WHERE key=? AND state='intent'").run(hash, raw, key); }
  settled(key: string, success: boolean, blockNumber: string) { this.db.prepare('UPDATE operations SET state=?, block_number=? WHERE key=?').run(success ? 'confirmed' : 'reverted', blockNumber, key); }
  retryReverted(key: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.operation(key);
      if (!previous || previous.state !== 'reverted' || !previous.hash || !previous.raw || !previous.blockNumber) throw new Error('Only a receipt-proven reverted transaction can start a fresh attempt.');
      this.db.prepare('INSERT INTO reverted_attempts(operation_key,fingerprint,hash,raw,block_number) VALUES(?,?,?,?,?)').run(key, previous.fingerprint, previous.hash, previous.raw, previous.blockNumber);
      this.db.prepare("UPDATE operations SET state='intent', hash=NULL, raw=NULL, block_number=NULL WHERE key=? AND state='reverted'").run(key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revertedAttempts(key: string) { return this.db.prepare('SELECT hash,block_number FROM reverted_attempts WHERE operation_key=? ORDER BY id').all(key); }
  pending(wallet: string): NativeOperation[] { const rows = this.db.prepare("SELECT key FROM operations WHERE wallet=? AND state='signed'").all(wallet) as { key: string }[]; return rows.map(row => this.operation(row.key)!); }
  operations(orgId: string) { const rows = this.db.prepare('SELECT key FROM operations WHERE org_id=?').all(orgId) as { key: string }[]; return rows.map(row => this.operation(row.key)!); }
  lock(wallet: string, owner: string, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM locks WHERE expires<=?').run(now);
      const acquired = this.db.prepare('INSERT OR IGNORE INTO locks(wallet,owner,expires) VALUES(?,?,?)').run(wallet, owner, now + 120_000).changes === 1;
      this.db.exec('COMMIT'); return acquired;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unlock(wallet: string, owner: string) { this.db.prepare('DELETE FROM locks WHERE wallet=? AND owner=?').run(wallet, owner); }
  renew(wallet: string, owner: string) { return this.db.prepare('UPDATE locks SET expires=? WHERE wallet=? AND owner=?').run(Date.now() + 120_000, wallet, owner).changes === 1; }
}
