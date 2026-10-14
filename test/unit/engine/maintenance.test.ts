import { computeMetrics, downtimeHoursInPeriod, openAsOf } from '../../../src/modules/engine/core/maintenance';
import type { BreakdownRecord } from '../../../src/modules/engine/core/types';

const bd = (over: Partial<BreakdownRecord> = {}): BreakdownRecord => ({
  id: 'b1', equipmentId: 'e1', equipmentCode: 'EQ1', equipmentName: 'Pump 1', criticality: 'major',
  startedAt: '2026-09-10T04:00:00.000Z', restoredAt: null, status: 'open', impact: 'reduced_capacity',
  causeCategory: null, expectedRestoreOn: '2026-09-11', fault: 'Bearing noise', ...over,
});

describe('engine/core/maintenance: pure, deterministic for a past report date (MNT-06/MNT-10)', () => {
  it('openAsOf: open until restored, and only as of dates on/after the restoration', () => {
    const open = bd();
    expect(openAsOf(open, '2026-09-10')).toBe(true);
    expect(openAsOf(open, '2026-09-30')).toBe(true); // still open on a much later report date

    const restored = bd({ status: 'restored', restoredAt: '2026-09-12T10:00:00.000Z' });
    expect(openAsOf(restored, '2026-09-11')).toBe(true); // open as of a date before the restoration
    expect(openAsOf(restored, '2026-09-12')).toBe(false); // restored same day → closed by end of that IST day
    expect(openAsOf(restored, '2026-09-13')).toBe(false);
  });

  it('a cancelled breakdown is never open and never counts toward downtime', () => {
    const cancelled = bd({ status: 'cancelled' });
    expect(openAsOf(cancelled, '2026-09-15')).toBe(false);
    expect(downtimeHoursInPeriod([cancelled], '2026-09-01', '2026-09-30')).toBe(0);
  });

  it('downtimeHoursInPeriod merges overlapping intervals of the SAME equipment', () => {
    const overlapping = [
      bd({ id: 'a', startedAt: '2026-09-10T00:00:00.000Z', restoredAt: '2026-09-10T10:00:00.000Z' }),
      bd({ id: 'b', startedAt: '2026-09-10T05:00:00.000Z', restoredAt: '2026-09-10T12:00:00.000Z' }), // overlaps a
    ];
    // Merged interval is 00:00–12:00 = 12 hours, not 10 + 7 = 17.
    expect(downtimeHoursInPeriod(overlapping, '2026-09-01', '2026-09-30')).toBeCloseTo(12, 5);
  });

  it('downtimeHoursInPeriod does NOT merge different equipment, and caps an open breakdown at the period end (never "now")', () => {
    const twoMachines = [
      bd({ id: 'a', equipmentId: 'e1', startedAt: '2026-09-10T00:00:00.000Z', restoredAt: '2026-09-10T05:00:00.000Z' }),
      bd({ id: 'b', equipmentId: 'e2', startedAt: '2026-09-29T00:00:00.000Z', restoredAt: null }), // still open
    ];
    // e1: 5 hours. e2: open from 2026-09-29T00:00Z to the end of the period (2026-09-30 23:59:59.999 IST) — bounded, deterministic.
    const hours = downtimeHoursInPeriod(twoMachines, '2026-09-01', '2026-09-30');
    const e2Hours = (new Date('2026-09-30T23:59:59.999+05:30').getTime() - new Date('2026-09-29T00:00:00.000Z').getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(5 + e2Hours, 5);
  });

  it('computeMetrics: availability% and MTTR over a period with a known equipment count', () => {
    const breakdowns = [
      bd({ id: 'a', startedAt: '2026-09-05T00:00:00.000Z', restoredAt: '2026-09-05T12:00:00.000Z', status: 'restored' }),
    ];
    const m = computeMetrics(breakdowns, '2026-09-01', '2026-09-30', 10, 2);
    expect(m.reported).toBe(1);
    expect(m.restored).toBe(1);
    expect(m.openEndOfPeriod).toBe(0);
    expect(m.mttrHrs).toBeCloseTo(12, 5);
    expect(m.downtimeHrs).toBeCloseTo(12, 5);
    expect(m.availabilityPct).not.toBeNull();
    expect(m.availabilityPct!).toBeGreaterThan(0.99); // 12 hrs out of 10 machines × 30 days is tiny
  });

  it('computeMetrics: a critical breakdown still open counts in criticalOpen and longestOpenDays', () => {
    const breakdowns = [bd({ criticality: 'critical', startedAt: '2026-09-01T00:00:00.000Z' })];
    const m = computeMetrics(breakdowns, '2026-09-01', '2026-09-10', 5, 1);
    expect(m.criticalOpen).toBe(1);
    expect(m.longestOpenDays).not.toBeNull();
    expect(m.longestOpenDays!).toBeCloseTo(10, 0);
  });
});
