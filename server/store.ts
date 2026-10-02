import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { User } from '../src/shared/types.js';
import { assertState, DomainError, emptyOrganization, nativeOrganization, nativePendingOrganization, seedOrganization, simulationOnly, type OrganizationState, type PresentationBundle } from './domain.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key)));
  return `scrypt$16384$${salt}$${hash.toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [scheme, cost, salt, hash] = encoded.split('$');
  if (scheme !== 'scrypt' || cost !== '16384' || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const computed = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key)));
  return timingSafeEqual(computed, Buffer.from(hash, 'hex'));
}
interface UserRow { id: string; name: string; email: string; role: 'owner' | 'worker'; organization_id: string; worker_id: string | null; password_hash: string; }
const publicUser = (row: UserRow): User => ({ id: row.id, name: row.name, email: row.email, role: row.role, organizationId: row.organization_id, ...(row.worker_id ? { workerId: row.worker_id } : {}) });
export interface StoredSession { user: User; csrfToken: string; expiresAt: number; }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','worker')), organization_id TEXT NOT NULL REFERENCES organizations(id), worker_id TEXT, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), worker_id TEXT NOT NULL, email TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS idempotency (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id,operation_key));
      CREATE TABLE IF NOT EXISTS native_operations (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, PRIMARY KEY(user_id,operation_key));
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS invitations_worker ON invitations(organization_id,worker_id);`);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  organization(organizationId: string): OrganizationState {
    const row = this.db.prepare('SELECT state FROM organizations WHERE id=?').get(organizationId) as { state: string } | undefined;
    if (!row) throw new DomainError('Company not found.', 'NOT_FOUND', 404);
    return JSON.parse(row.state) as OrganizationState;
  }
  save(state: OrganizationState) {
    assertState(state);
    this.db.prepare('UPDATE organizations SET state=? WHERE id=?').run(JSON.stringify(state), state.company.id);
  }
  mutate<T>(organizationId: string, fn: (state: OrganizationState) => T, operation?: { userId: string; key: string; fingerprint: string; now: number }): { result: T | undefined; state: OrganizationState } {
    return this.transaction(() => {
      if (operation) {
        this.db.prepare('DELETE FROM idempotency WHERE expires_at<=?').run(operation.now);
        const native = this.db.prepare('SELECT fingerprint FROM native_operations WHERE user_id=? AND operation_key=?').get(operation.userId, operation.key) as { fingerprint: string } | undefined;
        if (native && native.fingerprint !== operation.fingerprint) throw new DomainError('This operation key was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409);
        const previous = this.db.prepare('SELECT fingerprint FROM idempotency WHERE user_id=? AND operation_key=?').get(operation.userId, operation.key) as { fingerprint: string } | undefined;
        if (previous) {
          if (previous.fingerprint !== operation.fingerprint) throw new DomainError('This operation key was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409);
          return { result: undefined, state: this.organization(organizationId) };
        }
      }
      const state = this.organization(organizationId); const result = fn(state); this.save(state);
      if (operation) this.db.prepare('INSERT INTO idempotency(user_id,operation_key,fingerprint,expires_at) VALUES(?,?,?,?)').run(operation.userId, operation.key, operation.fingerprint, operation.now + 30 * 24 * 3_600_000);
      return { result, state };
    });
  }
  userByEmail(email: string) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase()) as UserRow | undefined; }
  insertUser(user: User, hash: string) { this.db.prepare('INSERT INTO users(id,name,email,role,organization_id,worker_id,password_hash) VALUES(?,?,?,?,?,?,?)').run(user.id, user.name, user.email, user.role, user.organizationId, user.workerId ?? null, hash); }
  registerOwner(input: { name: string; email: string; companyName: string }, hash: string, native = false) {
    return this.transaction(() => {
      if (this.userByEmail(input.email)) throw new DomainError('Unable to register this email. Try signing in instead.', 'REGISTRATION_UNAVAILABLE', 409);
      const organizationId = randomUUID(); const state = native ? nativePendingOrganization(organizationId, input.companyName) : emptyOrganization(organizationId, input.companyName);
      this.db.prepare('INSERT INTO organizations(id,state) VALUES(?,?)').run(organizationId, JSON.stringify(state));
      const user: User = { id: randomUUID(), name: input.name, email: input.email.toLowerCase(), role: 'owner', organizationId };
      this.insertUser(user, hash); return user;
    });
  }
  nativeOperation(userId: string, key: string, fingerprint: string): { complete: boolean; result?: { hash: string; blockNumber: string } } | undefined {
    const local = this.db.prepare('SELECT fingerprint FROM idempotency WHERE user_id=? AND operation_key=?').get(userId, key) as { fingerprint: string } | undefined;
    if (local && local.fingerprint !== fingerprint) throw new DomainError('This operation key was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409);
    const row = this.db.prepare('SELECT fingerprint,result FROM native_operations WHERE user_id=? AND operation_key=?').get(userId, key) as { fingerprint: string; result: string | null } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new DomainError('This native operation key was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409);
    return row.result ? { complete: true, result: JSON.parse(row.result) as { hash: string; blockNumber: string } } : { complete: false };
  }
  completedOperation(userId: string, key: string, fingerprint: string, now: number): boolean {
    const row = this.db.prepare('SELECT fingerprint FROM idempotency WHERE user_id=? AND operation_key=? AND expires_at>?').get(userId, key, now) as { fingerprint: string } | undefined;
    if (!row) return false;
    if (row.fingerprint !== fingerprint) throw new DomainError('This operation key was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409);
    return true;
  }
  beginNativeOperation(userId: string, key: string, fingerprint: string) {
    this.nativeOperation(userId, key, fingerprint);
    this.db.prepare('INSERT OR IGNORE INTO native_operations(user_id,operation_key,fingerprint,result) VALUES(?,?,?,NULL)').run(userId, key, fingerprint);
  }
  completeNativeOperation(userId: string, key: string, result: { hash: string; blockNumber: string }) {
    this.db.prepare('UPDATE native_operations SET result=? WHERE user_id=? AND operation_key=?').run(JSON.stringify(result), userId, key);
  }
  getUser(email: string): User | undefined { const row = this.userByEmail(email); return row ? publicUser(row) : undefined; }
  createSession(user: User, now = Date.now()) {
    const token = secret(), csrfToken = secret(), expiresAt = now + 12 * 3_600_000;
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(digest(token), user.id, csrfToken, expiresAt);
    return { token, csrfToken, expiresAt };
  }
  session(token: string, now = Date.now()): StoredSession | undefined {
    const row = this.db.prepare('SELECT u.*,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token), now) as (UserRow & { csrf_token: string; expires_at: number }) | undefined;
    return row ? { user: publicUser(row), csrfToken: row.csrf_token, expiresAt: row.expires_at } : undefined;
  }
  deleteSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); }
  presentationUser(role: 'owner' | 'worker', bundle: PresentationBundle, now = Date.now()): User {
    const organizationId = 'presentation_tempo';
    const owner: User = { id: 'presentation_owner_user', name: 'Jamie Morgan', email: 'presentation-owner@soleil.local', role: 'owner', organizationId };
    const worker: User = { id: 'presentation_worker_user', name: 'Maya Chen', email: 'presentation-worker@soleil.local', role: 'worker', organizationId, workerId: 'presentation_worker' };
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId)) {
        const state = nativeOrganization(bundle, now); assertState(state);
        this.db.prepare('INSERT INTO organizations(id,state) VALUES(?,?)').run(organizationId, JSON.stringify(state));
        this.insertUser(owner, 'presentation-only'); this.insertUser(worker, 'presentation-only');
      }
    });
    return role === 'owner' ? owner : worker;
  }
  demoUser(role: 'owner' | 'worker', now = Date.now()): User {
    const organizationId = 'demo_organization';
    const demoOwner: User = { id: 'demo_owner', name: 'Jamie Morgan', email: 'owner@soleil.local', role: 'owner', organizationId };
    const demoWorker: User = { id: 'demo_worker', name: 'Maya Chen', email: 'worker@soleil.local', role: 'worker', organizationId, workerId: 'demo_worker_maya' };
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId)) {
        this.db.prepare('INSERT INTO organizations(id,state) VALUES(?,?)').run(organizationId, JSON.stringify(seedOrganization(organizationId, demoOwner, now)));
        this.insertUser(demoOwner, 'demo-only'); this.insertUser(demoWorker, 'demo-only');
      }
    });
    return role === 'owner' ? demoOwner : demoWorker;
  }
  resetDemo(actor: User, now = Date.now()) {
    return this.mutate(actor.organizationId, state => {
      simulationOnly(state);
      if (!state.demoOrganization || actor.role !== 'owner') throw new DomainError('Only the demo owner can reset the seeded company.', 'DEMO_ONLY', 403);
      Object.assign(state, seedOrganization(actor.organizationId, actor, now));
      this.db.prepare('DELETE FROM invitations WHERE organization_id=?').run(actor.organizationId);
      // Reset removes invited demo identities and revokes their sessions, while preserving built-in owner/worker access.
      this.db.prepare("DELETE FROM users WHERE organization_id=? AND id NOT IN ('demo_owner','demo_worker')").run(actor.organizationId);
    }).state;
  }
  invite(actor: User, workerId: string, now = Date.now()) {
    return this.transaction(() => {
      const state = this.organization(actor.organizationId); const worker = state.workers.find(w => w.id === workerId);
      if (!worker) throw new DomainError('Contractor not found.', 'NOT_FOUND', 404);
      if (this.userByEmail(worker.email)) throw new DomainError('This contractor already has an account or cannot accept a new invitation.', 'INVITATION_UNAVAILABLE', 409);
      const token = secret();
      this.db.prepare('DELETE FROM invitations WHERE organization_id=? AND worker_id=?').run(actor.organizationId, workerId);
      this.db.prepare('INSERT INTO invitations(token_hash,organization_id,worker_id,email,expires_at) VALUES(?,?,?,?,?)').run(digest(token), actor.organizationId, workerId, worker.email, now + 72 * 3_600_000);
      return token;
    });
  }
  invitation(token: string, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE token_hash=? AND expires_at>? AND consumed_at IS NULL').get(digest(token), now) as { organization_id: string; worker_id: string; email: string } | undefined;
    if (!row) throw new DomainError('This invitation is invalid, expired or already used.', 'INVALID_INVITATION', 404);
    const state = this.organization(row.organization_id); const worker = state.workers.find(w => w.id === row.worker_id && w.email === row.email);
    if (!worker) throw new DomainError('This invitation is no longer available.', 'INVALID_INVITATION', 404);
    return { row, worker, state };
  }
  registerWorker(input: { name: string; email: string; invitationToken: string }, hash: string, now = Date.now()): User {
    return this.transaction(() => {
      const { row, worker, state } = this.invitation(input.invitationToken, now);
      if (input.email.toLowerCase() !== row.email || this.userByEmail(input.email)) throw new DomainError('The account must use the invited email address.', 'INVITATION_MISMATCH', 409);
      const user: User = { id: randomUUID(), name: input.name, email: row.email, role: 'worker', organizationId: row.organization_id, workerId: worker.id };
      this.insertUser(user, hash); worker.name = input.name;
      this.db.prepare('UPDATE invitations SET consumed_at=? WHERE token_hash=?').run(now, digest(input.invitationToken));
      this.save(state); return user;
    });
  }
}
