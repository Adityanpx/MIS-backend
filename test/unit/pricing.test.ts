import {
  buildBillingSchedule, escalatedYearAmounts, gstSplit, priceTable, subscriptionEndDate, sumAmounts, upfrontAmount,
} from '../../src/modules/domain/pricing';

describe('pricing (PLN-05/06)', () => {
  it('10-year plan, ₹54,000, 5% escalation', () => {
    const y = escalatedYearAmounts('54000', 5, 10);
    expect(y.map((r) => r.amount)).toEqual([
      '54000.00', '56700.00', '59535.00', '62511.75', '65637.34',
      '68919.20', '72365.16', '75983.42', '79782.59', '83771.72',
    ]);
    expect(sumAmounts(y)).toBe('679206.18');
    expect(upfrontAmount(y, 10)).toBe('611285.56');
  });
  it('rejects terms above 15 years', () => {
    expect(() => escalatedYearAmounts('1000', 0, 16)).toThrow();
  });
  it('GST split', () => {
    expect(gstSplit('54000.00', 18, true)).toMatchObject({ cgst: '4860.00', sgst: '4860.00', igst: '0.00', total: '63720.00' });
    expect(gstSplit('54000.00', 18, false)).toMatchObject({ igst: '9720.00', gstType: 'inter' });
    expect(gstSplit('54000.00', 18, null).gstType).toBe('unknown');
  });
  it('price table totals', () => {
    const t = priceTable({ termYears: 5, pricePerYear: '100000', escalationPct: 0, upfrontDiscountPct: 10, gstRatePct: 18 });
    expect(t.totalExGst).toBe('500000.00');
    expect(t.totalIncGst).toBe('590000.00');
    expect(t.upfront.amountExGst).toBe('450000.00');
  });
});

describe('billing schedule (SUB-02/03, INV-02)', () => {
  const base = {
    termYears: 5, pricePerYear: '54000', escalationPct: 5, upfrontDiscountPct: 10,
    invoiceLeadDays: 30, minPaymentTermsDays: 7,
  } as const;
  it('yearly: one row per year; first invoice today, due = max(period start, today + 7)', () => {
    const s = buildBillingSchedule({ ...base, billingMode: 'yearly', startDate: '2026-10-01', today: '2026-10-07' });
    expect(s).toHaveLength(5);
    expect(s[0]).toMatchObject({ periodFrom: '2026-10-01', periodTo: '2027-09-30', plannedInvoiceDate: '2026-10-07', dueDate: '2026-10-14' });
    expect(s[1]).toMatchObject({ periodFrom: '2027-10-01', plannedInvoiceDate: '2027-09-01', dueDate: '2027-10-01', amount: '56700.00' });
    expect(s[4]!.periodTo).toBe(subscriptionEndDate('2026-10-01', 5));
  });
  it('future start: invoice lead days before the start', () => {
    const s = buildBillingSchedule({ ...base, billingMode: 'yearly', startDate: '2027-03-01', today: '2026-10-07' });
    expect(s[0]).toMatchObject({ plannedInvoiceDate: '2027-01-30', dueDate: '2027-03-01' });
  });
  it('upfront: a single discounted row for the whole term', () => {
    const s = buildBillingSchedule({ ...base, billingMode: 'upfront', startDate: '2026-10-01', today: '2026-10-07' });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ periodFrom: '2026-10-01', periodTo: '2031-09-30', amount: '268545.68' });
  });
});
