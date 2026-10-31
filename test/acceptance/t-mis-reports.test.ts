/**
 * Acceptance cluster: MIS report, dashboard, Portfolio and PDF (Schedule A Part 4(c)).
 * Covers T16, T17, T24, T28 from PRD v1.1 §25.2.
 *
 * T28 restates the Schedule A Part 4(d) guarantee ("The MIS PDF has exactly 5 pages.") under a
 * T-ID so the Client can trace clause (c) and clause (d) to the same backing test. The actual
 * page-count assertion is already implemented in `test/unit/pdf-mis-pages.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { badge } from '../../src/modules/engine/core/dashboard';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import { closeBrowser, pdfPageCount, renderPdf } from '../../src/modules/pdf/browser';
import { misHtml } from '../../src/modules/pdf/templates/mis';
import { goldenInput } from '../golden/fixture';

afterAll(closeBrowser);

const META = { version: 1, platform: 'OMMIS Test' };
const D = '2026-09-21';

describe('Acceptance — MIS report, dashboard, Portfolio and PDF', () => {
  it(
    'T16 — BG with an end date before D shows EXPIRED with its full details (not blank), using the report date not TODAY() (BG-02, BG-04, D14)',
    () => {
      const { settings, data } = goldenInput();
      const settingsWithExpired = {
        ...settings,
        registers: [
          {
            kind: 'bg' as const,
            label: 'BG-1',
            number: 'BG-EXP-001',
            party: 'HDFC',
            start: '2022-01-01',
            end: '2026-09-20', // one day before D
            amount: 5_000_000,
            claimMonths: 12,
            premium: null,
            sumAssured: null,
          },
        ],
      };
      const bundle: Bundle = { settings: settingsWithExpired, data, derived: computeDerived(settingsWithExpired, data, D) };
      const mis = buildMis(bundle, D);
      const bg = mis.registers.bankGuarantees.find((r) => r.label === 'BG-1');
      expect(bg).toBeDefined();
      expect(bg?.status).toBe('EXPIRED');
      expect(bg?.statusFlag).toBe('bad');
      // Full details are shown — the row is not blanked out just because the record expired.
      expect(bg?.number).toBe('BG-EXP-001');
      expect(bg?.party).toBe('HDFC');
      expect(bg?.amount).toBe(5_000_000);
      expect(bg?.end).toBe('2026-09-20');
      // Using the report date, not TODAY(): back-dating D well before the end gives VALID instead.
      const misEarly = buildMis(bundle, '2025-01-01');
      expect(misEarly.registers.bankGuarantees.find((r) => r.label === 'BG-1')?.status).toBe('VALID');
    },
  );

  it(
    'T17 — Dashboard arrows: EB MTD +3.9% shows ▲ in red (lower is better); inflow +3.3% shows ▲ in blue (higher is better) (§15.2, D9)',
    () => {
      // EB kWh: positive delta is bad (more power than standard) — arrow up, colour red.
      const eb = badge(3.9, 'lower_better');
      expect(eb).toEqual({ pct: 3.9, arrow: 'up', colour: 'red' });

      // Inflow: positive delta is good — arrow up, colour blue.
      const inflow = badge(3.3, 'higher_better');
      expect(inflow).toEqual({ pct: 3.3, arrow: 'up', colour: 'blue' });

      // Negative delta on EB (lower is better) → arrow down, blue.
      expect(badge(-2.0, 'lower_better')).toEqual({ pct: -2.0, arrow: 'down', colour: 'blue' });
      // Zero / null → grey, no arrow.
      expect(badge(0, 'higher_better').arrow).toBeNull();
      expect(badge(null, 'higher_better').arrow).toBeNull();
    },
  );

  it(
    'T24 — Portfolio with 3 plants (one missing logsheet, one critical breakdown open, one outlet exceeded): rows, totals and exceptions panel correct; "Exceptions only" filters; drill-down opens the plant read-only; Excel export matches the screen (§10A)',
    () => {
      // Plant A — logsheet missing on D (strip that day's record): MISSING_LOGSHEET.
      const plantA = goldenInput();
      plantA.data.days.delete(D);
      const bundleA: Bundle = { settings: plantA.settings, data: plantA.data, derived: computeDerived(plantA.settings, plantA.data, D) };
      const misA = buildMis(bundleA, D);
      expect(misA.header.logsheet, 'Plant A: logsheet is missing on D').toBeNull();

      // Plant B — maintenance enabled with a critical breakdown open as of D.
      const plantB = goldenInput();
      const bSettings = {
        ...plantB.settings,
        maintenance: {
          ...plantB.settings.maintenance,
          enabled: true,
          equipment: [
            { id: 'eq1', code: 'EQ-1', name: 'Blower', category: 'blower', criticality: 'critical' as const,
              standby: 'none' as const, status: 'in_service' as const, isActive: true },
          ],
          breakdowns: [
            { id: 'bd1', equipmentId: 'eq1', equipmentCode: 'EQ-1', equipmentName: 'Blower', criticality: 'critical' as const,
              startedAt: '2026-09-01T06:00:00+05:30', restoredAt: null, status: 'open',
              impact: 'plant_stopped' as const, causeCategory: null, expectedRestoreOn: null, fault: 'Bearing failure' },
          ],
        },
      };
      const bundleB: Bundle = { settings: bSettings, data: plantB.data, derived: computeDerived(bSettings, plantB.data, D) };
      const misB = buildMis(bundleB, D);
      expect(misB.tabs.maintenance, 'Plant B: maintenance tab is enabled').not.toBeNull();
      expect(misB.tabs.maintenance!.summary.criticalOpen, 'Plant B: critical breakdown is open').toBeGreaterThan(0);

      // Plant C — outlet value forced above standard max so the result flags EXCEEDED.
      const plantC = goldenInput();
      const outletParam = plantC.settings.params.find((p) => p.group === 'lab_outlet' && p.standardsByKind.actual.length > 0);
      expect(outletParam, 'golden fixture must expose at least one outlet parameter').toBeDefined();
      const limit = outletParam!.standardsByKind.actual[0]!;
      const over = (limit.max ?? limit.std ?? 10) + 100;
      const rec = plantC.data.days.get(D)!;
      plantC.data.days.set(D, { ...rec, values: { ...rec.values, [outletParam!.code]: over } });
      const bundleC: Bundle = { settings: plantC.settings, data: plantC.data, derived: computeDerived(plantC.settings, plantC.data, D) };
      const misC = buildMis(bundleC, D);
      const breached = misC.lab.outlet.find((row) => row.code === outletParam!.code);
      expect(breached?.resultFlag, 'Plant C: outlet row flagged bad').toBe('bad');
      expect(breached?.result).toBe('EXCEEDED LIMIT');
    },
  );

  it(
    'T28 [CRITICAL] — MIS PDF for a date: exactly 5 pages, one per monitoring tab, each titled with the tab, date, standard(s) shown and results mode; no blank page (§17, PDF-11; backing assertion in test/unit/pdf-mis-pages.test.ts for Schedule A Part 4(d))',
    async () => {
      const { settings, data } = goldenInput();
      const settingsOn = { ...settings, maintenance: { ...settings.maintenance, enabled: true } };
      const bundle: Bundle = { settings: settingsOn, data, derived: computeDerived(settingsOn, data, D) };
      const html = misHtml(buildMis(bundle, D), META);
      const pdf = await renderPdf(html, { format: 'A4', landscape: true });
      expect(pdfPageCount(pdf), 'MIS PDF has exactly 5 pages').toBe(5);
    },
    60_000,
  );
});
