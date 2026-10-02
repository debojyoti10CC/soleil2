import { describe, expect, it } from 'vitest';
import type { User } from '../src/shared/types.js';
import { addWorker, allocate, approveInvoice, assertState, blockWorker, commitInvoice, confirmWorker, createInvoice, deposit, emptyOrganization, payInvoices, receipt, retire, simulateStrategy, snapshot, units, withdraw } from './domain.js';

const time = Date.parse('2026-01-01T00:00:00.000Z');
const owner: User = { id: 'owner', name: 'Owner', email: 'owner@example.org', role: 'owner', organizationId: 'org' };
function fixture() {
  const state = emptyOrganization('org', 'Company'); const vault = state.vaults[0]!;
  const worker = addWorker(state, owner, { name: 'Worker', email: 'worker@example.org', address: 'sim_worker', rail: 'solana' }, time);
  const actor: User = { id: 'worker-user', name: 'Worker', email: worker.email, role: 'worker', workerId: worker.id, organizationId: 'org' };
  confirmWorker(state, actor, worker.id, time); deposit(state, owner, vault.id, '20000000000', time);
  const invoice = createInvoice(state, owner, { workerId: worker.id, description: 'Earned invoice', amount: '10000000000', rail: 'solana', dueAt: new Date(time).toISOString() }, time);
  approveInvoice(state, owner, invoice.id, time); commitInvoice(state, owner, invoice.id, time);
  return { state, vault, worker, actor, invoice };
}
describe('precise money and commitment invariants', () => {
  it('keeps values beyond Number precision exact and rejects ambiguous units', () => {
    expect(units('9007199254740993')).toBe(9007199254740993n);
    for (const input of [1, '1.0', '-1', '01', '1e6', '', '0', '340282366920938463463374607431768211456']) expect(() => units(input)).toThrow();
  });
  it('new organizations start with zero simulated funds and separate liabilities', () => {
    const s = emptyOrganization('new', 'New'); expect(s.vaults.every(v => v.balance === '0' && v.committed === '0')).toBe(true);
  });
  it('rejects commitment if recipient is unconfirmed or actual liquid coverage is missing', () => {
    const { state, worker } = fixture(); worker.confirmed = false;
    const i = createInvoice(state, owner, { workerId: worker.id, description: 'Another', amount: '9000000000', rail: 'solana', dueAt: new Date(time).toISOString() }, time); approveInvoice(state, owner, i.id, time);
    expect(() => commitInvoice(state, owner, i.id, time)).toThrow('confirm'); worker.confirmed = true;
    expect(() => commitInvoice(state, owner, i.id, time)).toThrow('Fund'); expect(i.status).toBe('approved'); assertState(state);
  });
  it('protects commitments plus buffer from withdrawals and strategy allocation', () => {
    const { state, vault } = fixture(); expect(vault.surplus).toBe('8000000000');
    expect(() => withdraw(state, owner, vault.id, '8000000001', time)).toThrow('surplus');
    expect(() => allocate(state, owner, vault.id, '8000000001', time)).toThrow('surplus');
    withdraw(state, owner, vault.id, '8000000000', time); expect(vault.balance).toBe('12000000000'); expect(vault.committed).toBe('10000000000'); assertState(state);
  });
  it('strategy loss never changes liquid worker coverage; recovery works in protected mode', () => {
    const { state, vault, invoice, actor } = fixture(); allocate(state, owner, vault.id, '7000000000', time);
    simulateStrategy(state, owner, vault.id, 'loss', '3000000000', time); expect(vault.balance).toBe('13000000000'); expect(vault.strategyValue).toBe('4000000000');
    expect(() => allocate(state, owner, vault.id, '1', time)).toThrow('Protected'); payInvoices(state, actor, [invoice.id], time);
    const current = state.vaults[0]!; expect(current.balance).toBe('3000000000'); expect(current.committed).toBe('0');
    simulateStrategy(state, owner, current.id, 'recover', undefined, time); expect(current.balance).toBe('7000000000'); expect(current.strategyPrincipal).toBe('0'); expect(current.riskMode).toBe('normal'); assertState(state);
  });
  it('delay is explicit and does not count strategy value as coverage', () => {
    const { state, vault } = fixture(); allocate(state, owner, vault.id, '8000000000', time); simulateStrategy(state, owner, vault.id, 'delay', undefined, time);
    expect(vault.balance).toBe('12000000000'); expect(vault.surplus).toBe('0'); expect(vault.strategyDelayed).toBe(true);
  });
  it('a blocked settlement preserves every principal/liability/status and posting', () => {
    const { state, worker, invoice, actor } = fixture(); blockWorker(state, owner, worker.id, true, time); const before = structuredClone(state);
    expect(() => payInvoices(state, actor, [invoice.id], time)).toThrow('blocked'); expect(state).toEqual(before);
  });
  it('rejects immature payments and cannot pay the same consumed ID twice', () => {
    const { state, invoice, actor } = fixture(); expect(() => payInvoices(state, actor, [invoice.id], time - 1)).toThrow('due time');
    payInvoices(state, actor, [invoice.id], time); const after = structuredClone(state); expect(() => payInvoices(state, actor, [invoice.id], time)).toThrow('unpaid'); expect(state).toEqual(after);
  });
  it('fixed committed recipient survives later metadata changes', () => {
    const { state, worker, invoice, actor } = fixture(); worker.address = 'changed_metadata'; payInvoices(state, actor, [invoice.id], time);
    expect(receipt(state, actor, invoice.id).recipient).toBe('sim_worker');
  });
  it('an invalid later batch item rolls back all earlier payments', () => {
    const { state, invoice, worker } = fixture(); const second = createInvoice(state, owner, { workerId: worker.id, description: 'Draft', amount: '1', rail: 'solana', dueAt: new Date(time).toISOString() }, time); const before = structuredClone(state);
    expect(() => payInvoices(state, owner, [invoice.id, second.id], time)).toThrow('unpaid'); expect(state).toEqual(before);
    expect(() => payInvoices(state, owner, [invoice.id, invoice.id], time)).toThrow('distinct');
  });
  it('workers can claim their invoice but cannot control another worker or owner workflows', () => {
    const { state, actor, vault } = fixture(); const other = addWorker(state, owner, { name: 'Other', email: 'other@example.org', address: 'sim_other', rail: 'solana' }, time);
    expect(() => confirmWorker(state, actor, other.id, time)).toThrow('Only this'); expect(() => confirmWorker(state, owner, actor.workerId!, time)).toThrow('Only this'); expect(() => withdraw(state, actor, vault.id, '1', time)).toThrow('owner');
    const view = snapshot(state, actor, time); expect(view.workers.map(w => w.id)).toEqual([actor.workerId]); expect(view.invoices.every(i => i.workerId === actor.workerId)).toBe(true);
  });
  it('a buffer shortfall allows funded claims; a principal shortfall blocks every claimant', () => {
    const { state, invoice, actor, vault } = fixture(); vault.balance = '11000000000'; payInvoices(state, actor, [invoice.id], time); expect(state.vaults[0]!.balance).toBe('1000000000');
    const other = fixture(); other.vault.balance = '9999999999'; const before = structuredClone(other.state); expect(() => payInvoices(other.state, other.actor, [other.invoice.id], time)).toThrow('fully covered'); expect(other.state).toEqual(before);
  });
  it('retirement only releases buffer at zero liabilities and permanently disables commitments', () => {
    const { state, invoice, actor, vault, worker } = fixture(); expect(() => retire(state, owner, vault.id, time)).toThrow('every commitment'); payInvoices(state, actor, [invoice.id], time);
    retire(state, owner, vault.id, time); const current = state.vaults[0]!; expect(current.buffer).toBe('0'); expect(current.retired).toBe(true);
    expect(() => createInvoice(state, owner, { workerId: worker.id, description: 'New', amount: '1', rail: 'solana', dueAt: new Date(time).toISOString() }, time)).toThrow('retired'); withdraw(state, owner, current.id, current.balance, time); expect(current.balance).toBe('0'); assertState(state);
  });
  it('receipt identifies the local simulation and never fabricates an explorer URL', () => {
    const { state, invoice, actor } = fixture(); const r = receipt(state, actor, invoice.id); expect(r.mode).toBe('demo'); expect(r.transactionRef).toMatch(/^sim_/); expect(r.statement).toContain('No blockchain'); expect(JSON.stringify(r)).not.toMatch(/explorer|etherscan|solscan/);
  });
  it('lifetime received totals can exceed a single vault bound without blocking later claims', () => {
    const state = emptyOrganization('org', 'Company'), vault = state.vaults[0]!;
    const worker = addWorker(state, owner, { name: 'Worker', email: 'worker@example.org', address: 'sim_worker', rail: 'solana' }, time);
    const actor: User = { id: 'worker', name: 'Worker', email: worker.email, role: 'worker', workerId: worker.id, organizationId: 'org' };
    confirmWorker(state, actor, worker.id, time);
    const maximum = (1n << 128n) - 1n, payment = maximum - BigInt(vault.buffer);
    for (let n = 0; n < 3; n++) {
      const current = state.vaults[0]!; deposit(state, owner, current.id, (maximum - BigInt(current.balance)).toString(), time);
      const invoice = createInvoice(state, owner, { workerId: worker.id, description: `Cycle ${n}`, amount: payment.toString(), rail: 'solana', dueAt: new Date(time).toISOString() }, time);
      approveInvoice(state, owner, invoice.id, time); commitInvoice(state, owner, invoice.id, time); payInvoices(state, actor, [invoice.id], time); assertState(state);
    }
    expect(state.workers[0]!.received).toBe((payment * 3n).toString());
  });
});
