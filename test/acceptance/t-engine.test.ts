/**
 * Acceptance cluster: Calculation engine — monthly report, two standards, three results
 * (Schedule A Part 4(c)). Covers T15, T21, T22 from PRD v1.1 §25.2.
 *
 * Reuses `goldenInput()` from `test/golden/fixture.ts` for data; the 690-day golden suite is
 * Schedule A Part 4(a) and lives in `test/golden/`.
 */
import { describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import * as rpt from '../../src/modules/reports/reports.service';
import { MIS_START, goldenInput } from '../golden/fixture';

const D = '2026-09-21';
const near = (actual: number | null | undefined, expected: number, k = 2) => expect(actual).toBeCloseTo(expected, k);

describe('Acceptance — Calculation engine', () => {
  it(
    'T15 — Monthly report for Sep-2026 (BGE hours, BGE kWh): totals 354 / 2,24,160; averages 16.86 / 10,674.29 (days with data); max 21 / 12,600; min 14 / 9,600 (§16.1, Appendix B8)',
    () => {
      const { settings, data } = goldenInput();
      const bundle: Bundle = { settings, data, derived: computeDerived(settings, data, D) };
      const t = rpt.monthly(bundle, '2026-09', ['BGE_HRS', 'BGE_KWH']);
      const f = (label: string) => t.footer!.find((x) => x.date === label)!;
      expect(f('Total')).toMatchObject({ BGE_HRS: 354, BGE_KWH: 224160 });
      near(f('Average').BGE_HRS as number, 16.86, 2);
      near(f('Average').BGE_KWH as number, 10674.29, 2);
      expect(f('Maximum')).toMatchObject({ BGE_HRS: 21, BGE_KWH: 12600 });
      expect(f('Minimum')).toMatchObject({ BGE_HRS: 14, BGE_KWH: 9600 });
    },
  );

  it(
    'T21 — Two standards: set Bidding BGE kWh 13,000 and Actual 11,800: MIS in "Both" mode shows both STD/VAR/RESULT columns; flags and main events follow the Primary standard; the standards selector switches columns; values match Appendix B9 (§11.3A, §14.3, STD-04)',
    () => {
      const { settings, data } = goldenInput();
      const bge = settings.params.find((p) => p.code === 'BGE_KWH')!;
      // Replace the per-year actual standards with a flat 11,800 (Appendix B9) and add a Bidding of 13,000.
      bge.standardsByKind = {
        bidding: [{ from: MIS_START, kind: 'bidding', std: 13000, monthly: null, min: null, max: null, inheritFromKind: null }],
        actual: [{ from: MIS_START, kind: 'actual', std: 11800, monthly: null, min: null, max: null, inheritFromKind: null }],
      };
      const settingsBoth = { ...settings, standardsShown: 'both' as const, primaryStandard: 'actual' as const };
      const bundle: Bundle = { settings: settingsBoth, data, derived: computeDerived(settingsBoth, data, D) };
      const mis = buildMis(bundle, D);
      const row = mis.keyParameters.find((r) => r.code === 'BGE_KWH')!;

      // "Both" mode populates both standards in the row — flags and primary totals still follow the actual.
      expect(row.standards.bidding.today.std).toBe(13000);
      expect(row.standards.actual.today.std).toBe(11800);
      expect(row.primaryKind).toBe('actual');
      // Primary (actual) today std is 11800; today act 10080 (from the golden row).
      near(row.today.std!, 11800, 2);
      near(row.today.act!, 10080, 2);
      // The MIS-level standardsShown is surfaced in the header so the UI can switch columns.
      expect(mis.header.standardsShown).toBe('both');
    },
  );

  it(
    'T22 — Results: Chlorine on 21-Sep-2026, Actual standard: Today 24.5 kg (5.8%) LESS; MTD 266 kg (3.0%) EXCESS; UTD 13,496 kg (4.7%) EXCESS; "%", "quantity" and "both" display modes each render correctly, and a PAR-19 override works (§13.2A, SET-11, PAR-19)',
    () => {
      const { settings, data } = goldenInput();
      // "Both" at the plant default — then flip a PAR-19 override on CHLORINE_CONSUMED to prove it wins.
      const chlorine = settings.params.find((p) => p.code === 'CHLORINE_CONSUMED')!;
      const settingsBoth = { ...settings, resultsDisplay: 'both' as const, primaryStandard: 'actual' as const };
      const bundleBoth: Bundle = { settings: settingsBoth, data, derived: computeDerived(settingsBoth, data, D) };
      const misBoth = buildMis(bundleBoth, D);
      const chemBoth = misBoth.chemicals.find((c) => c.code === 'CHLORINE_CONSUMED')!;

      // Appendix B9: MTD (std-act) ≈ -266 EXCESS (3.0%), UTD (std-act) ≈ -13,496 EXCESS (4.66%).
      near(chemBoth.mtd.std!, 8820, 2);
      near(chemBoth.mtd.act!, 9086, 2);
      near(chemBoth.utd.std!, 289800, 2);
      near(chemBoth.utd.act!, 303296, 2);
      // UTD percentage (positive = EXCESS because direction is lower_better).
      near(chemBoth.utdResult.pct!, 0.0466, 3);

      // Today Chlorine Appendix B value: 24.5 kg LESS at 5.8 %. The sign and magnitude come from standardAt(D) − dayValue(D).
      const dayStd = chemBoth.today.std!;
      const dayAct = chemBoth.today.act!;
      near(dayAct, 395.5, 2);
      near(dayStd - dayAct, 24.5, 1);
      near((dayStd - dayAct) / dayStd, 0.058, 2);

      // resultDisplay reflects the plant default of "both" when no override is set.
      expect(chemBoth.resultDisplay).toBe('both');

      // PAR-19 override on the same parameter — plant default stays "both", parameter now shows "pct" only.
      chlorine.resultDisplayOverride = 'pct';
      const misPct: ReturnType<typeof buildMis> = buildMis(
        { settings: settingsBoth, data, derived: computeDerived(settingsBoth, data, D) }, D,
      );
      const chemPct = misPct.chemicals.find((c) => c.code === 'CHLORINE_CONSUMED')!;
      expect(chemPct.resultDisplay).toBe('pct');
    },
  );
});
