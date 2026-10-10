import { addDays } from '../../src/lib/dates';
import { allocateOldestFirst } from '../../src/modules/billing/allocation';
import { inWordsIndian, rupeesInWords } from '../../src/modules/billing/amount-words';
import { invoiceMath } from '../../src/modules/billing/invoices.service';
import { formatDocNumber } from '../../src/modules/billing/numbering';
import { coveredDays, evaluate, rollupClientState, type PlantLifecycleInput } from '../../src/modules/lifecycle/evaluate';

describe('billing helpers', () => {
  it('amount in words (Indian system)', () => {
    expect(rupeesInWords('70800.00')).toBe('Rupees Seventy Thousand Eight Hundred Only');
    expect(inWordsIndian(13046190)).toBe('One Crore Thirty Lakh Forty Six Thousand One Hundred Ninety');
    expect(rupeesInWords('1001.50')).toBe('Rupees One Thousand One and Fifty Paise Only');
  });
  it('document numbers', () => {
    expect(formatDocNumber('INV', '2026-27', 1)).toBe('INV/2026-27/0001');
    expect(formatDocNumber('RCPT', '2027-28', 123)).toBe('RCPT/2027-28/0123');
  });
  it('GST split and round-off (INV-03/04)', () => {
    expect(invoiceMath([{ qty: 1, rate: '54000.00' }], 18, false))
      .toMatchObject({ taxable: '54000.00', igst: '9720.00', cgst: '0.00', roundOff: '0.00', total: '63720.00', gstType: 'inter' });
    expect(invoiceMath([{ qty: 1, rate: '56700.55' }], 18, true))
      .toMatchObject({ taxable: '56700.55', cgst: '5103.05', sgst: '5103.05', roundOff: '0.35', total: '66907.00', gstType: 'intra' });
  });
  it('oldest-first allocation, remainder to credit (OFF-04, E14)', () => {
    const open = [
      { id: 'b', balance: '60000.00', dueDate: '2026-02-01', issueDate: '2026-01-02' },
      { id: 'a', balance: '50000.00', dueDate: '2026-01-01', issueDate: '2025-12-02' },
    ];
    expect(allocateOldestFirst('100000', open)).toEqual([{ invoiceId: 'a', amount: '50000.00' }, { invoiceId: 'b', amount: '50000.00' }]);
    expect(allocateOldestFirst('120000', open)).toEqual([
      { invoiceId: 'a', amount: '50000.00' }, { invoiceId: 'b', amount: '60000.00' }, { invoiceId: null, amount: '10000.00' },
    ]);
  });
});

describe('lifecycle evaluator (PRD §9.3–9.4)', () => {
  const r = { graceDays: 15, readOnlyDays: 15, suspendedDays: 60, renewalWindowDays: 30 };
  const due = '2026-01-01';
  const base = (over: Partial<PlantLifecycleInput> = {}): PlantLifecycleInput => ({
    current: 'active', manualSuspended: false, holds: [], tolerance: '10.00',
    invoices: [{ id: 'i1', number: 'INV/1', dueDate: due, balance: '63720.00', pauses: [] }],
    subscriptions: [{ start: '2025-01-01', end: '2029-12-31', status: 'active' }],
    ...over,
  });
  const at = (days: number, over: Partial<PlantLifecycleInput> = {}) => evaluate(base(over), addDays(due, days), r).state;

  it('timeline: grace D+1..15, read-only D+16..30, suspended D+31..90, terminated D+91', () => {
    expect(at(0)).toBe('active');
    expect(at(1)).toBe('grace');
    expect(at(15)).toBe('grace');
    expect(at(16)).toBe('read_only');
    expect(at(30)).toBe('read_only');
    expect(at(31)).toBe('suspended');
    expect(at(90)).toBe('suspended');
    expect(at(91)).toBe('terminated');
    expect(evaluate(base(), due, r).nextChange).toEqual({ on: addDays(due, 1), state: 'grace' });
  });
  it('a balance within the tolerance never restricts', () => {
    expect(at(40, { invoices: [{ id: 'i1', number: null, dueDate: due, balance: '5.00', pauses: [] }] })).toBe('active');
  });
  it('a pending cheque pauses the clock (OFF-02)', () => {
    const pauses = [{ from: '2026-01-05', to: '2026-01-19' }];
    expect(at(19, { invoices: [{ id: 'i1', number: null, dueDate: due, balance: '100.00', pauses }] })).toBe('grace'); // 19 − 15 paused = 4
    expect(at(19)).toBe('read_only');
  });
  it('a hold keeps the plant active and its days never count (LC-05, E30)', () => {
    const holds = [{ from: '2026-01-10', to: '2026-02-28' }];
    expect(evaluate(base({ holds }), '2026-02-15', r)).toMatchObject({ state: 'active', cause: 'hold' });
    expect(evaluate(base({ holds }), '2026-03-05', r).state).toBe('grace'); // 63 days − 50 held = 13
  });
  it('expiry: renewal window, then suspended, then terminated (LC-06)', () => {
    const subs = [{ start: '2021-01-01', end: '2025-12-31', status: 'ended' }];
    const e = (d: string) => evaluate(base({ invoices: [], subscriptions: subs }), d, r).state;
    expect(e('2025-12-31')).toBe('active');
    expect(e('2026-01-01')).toBe('expired');
    expect(e('2026-01-30')).toBe('expired');
    expect(e('2026-01-31')).toBe('suspended');
    expect(e('2026-04-01')).toBe('terminated');
  });
  it('manual suspension, sticky termination, client roll-up', () => {
    expect(evaluate(base({ invoices: [], manualSuspended: true }), due, r)).toMatchObject({ state: 'suspended', cause: 'manual' });
    expect(evaluate(base({ invoices: [], current: 'terminated' }), due, r).state).toBe('terminated');
    expect(evaluate(base({ invoices: [], current: 'terminated' }), due, r, { allowFromTerminated: true }).state).toBe('active');
    expect(rollupClientState(['suspended', 'grace'], false)).toBe('grace');
    expect(rollupClientState(['suspended', 'terminated'], false)).toBe('suspended');
    expect(rollupClientState(['expired'], false)).toBe('read_only');
    expect(rollupClientState([], false)).toBe('active');
    expect(rollupClientState(['active'], true)).toBe('suspended');
  });
  it('coveredDays merges overlapping windows', () => {
    expect(coveredDays('2026-01-10', '2026-01-20', [{ from: '2026-01-05', to: '2026-01-12' }, { from: '2026-01-12', to: '2026-01-14' }])).toBe(4);
  });
});
