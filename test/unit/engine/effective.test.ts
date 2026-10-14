import { standardAt } from '../../../src/modules/engine/core/effective';
import type { ParamDef, StandardRow } from '../../../src/modules/engine/core/types';

const row = (from: string, over: Partial<StandardRow> = {}): StandardRow => ({
  from, kind: 'actual', std: 100, monthly: null, min: null, max: null, inheritFromKind: null, ...over,
});

const baseParam: Omit<ParamDef, 'standardsByKind'> = {
  id: 'p1', code: 'X', name: 'X', shortName: null, group: 'key', unit: 'u', inputMode: 'typed', formula: null,
  decimals: 2, hardMin: null, hardMax: null, aggregation: 'sum', stdType: 'per_day', direction: 'higher_better',
  eventRule: 'above_std', resultNoun: null, linkRole: null, stockItemId: null, staffCategoryId: null, safetyItemId: null,
  block: 1, order: 1, misSection: null, misOrder: 1, dashboardCard: false, dashboardOrder: 1, chartType: 'none',
  chartMetric: null, mandatory: true, activeFrom: null, activeTo: null, monitoringTab: 'key', resultDisplayOverride: null,
};

describe('engine/core/effective: two-standard lookup (STD-03/STD-08)', () => {
  it('each kind resolves independently from its own series', () => {
    const p: ParamDef = {
      ...baseParam,
      standardsByKind: {
        bidding: [row('2024-01-01', { std: 50 })],
        actual: [row('2024-01-01', { std: 100 }), row('2024-06-01', { std: 120 })],
      },
    };
    expect(standardAt(p, '2024-03-01', 'bidding')?.std).toBe(50);
    expect(standardAt(p, '2024-03-01', 'actual')?.std).toBe(100);
    expect(standardAt(p, '2024-07-01', 'actual')?.std).toBe(120);
  });

  it('an empty series (never configured) resolves to undefined, not a fallback to the other kind', () => {
    const p: ParamDef = { ...baseParam, standardsByKind: { bidding: [], actual: [row('2024-01-01')] } };
    expect(standardAt(p, '2024-03-01', 'bidding')).toBeUndefined();
    expect(standardAt(p, '2024-03-01', 'actual')?.std).toBe(100);
  });

  it('inheritFromKind resolves from the other series on that date', () => {
    const p: ParamDef = {
      ...baseParam,
      standardsByKind: {
        bidding: [row('2024-01-01', { std: null, inheritFromKind: 'actual' })],
        actual: [row('2024-01-01', { std: 100 }), row('2024-06-01', { std: 120 })],
      },
    };
    expect(standardAt(p, '2024-03-01', 'bidding')?.std).toBe(100);
    expect(standardAt(p, '2024-07-01', 'bidding')?.std).toBe(120); // follows the Actual series as it changes over time
  });

  it('falls back to the inheriting row itself if the other kind has nothing at that date', () => {
    const p: ParamDef = {
      ...baseParam,
      standardsByKind: { bidding: [row('2024-01-01', { std: 10, inheritFromKind: 'actual' })], actual: [] },
    };
    expect(standardAt(p, '2024-03-01', 'bidding')?.std).toBe(10);
  });
});
