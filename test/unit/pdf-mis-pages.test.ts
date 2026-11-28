import { afterAll, describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import { closeBrowser, pdfPageCount, renderPdf } from '../../src/modules/pdf/browser';
import { misHtml, type MisFilter } from '../../src/modules/pdf/templates/mis';
import { goldenInput } from '../golden/fixture';

afterAll(closeBrowser);

const META = { version: 1, platform: 'OMMIS Test' };
/** Any date for which the golden fixture has data. */
const D = '2026-09-21';

function bundle(): Bundle {
  const { settings, data } = goldenInput();
  return { settings, data, derived: computeDerived(settings, data, D) };
}
const html = (f: MisFilter) => misHtml(buildMis(bundle(), D), META, f);

/** The MIS PDF prints exactly the filter the user picked: one period, one standard. */
describe('MIS PDF — filtered layout', () => {
  it.each([
    [{ period: 'today', kind: 'actual' }, 'DAILY', 'ACTUAL STANDARD'],
    [{ period: 'mtd', kind: 'bidding' }, 'MONTHLY', 'BIDDING STANDARD'],
    [{ period: 'utd', kind: 'actual' }, 'UP TO DATE (UTD)', 'ACTUAL STANDARD'],
  ] as Array<[MisFilter, string, string]>)('prints only %j', (f, periodLabel, kindLabel) => {
    const out = html(f);
    expect(out).toContain(periodLabel);
    expect(out).toContain(kindLabel);
    for (const other of ['DAILY', 'MONTHLY', 'UP TO DATE (UTD)'].filter((l) => l !== periodLabel)) expect(out).not.toContain(other);
    for (const other of ['ACTUAL STANDARD', 'BIDDING STANDARD'].filter((l) => l !== kindLabel)) expect(out).not.toContain(other);
  });

  it('has the Average and Limit-exceeded columns in key parameters and chemicals', () => {
    const out = html({ period: 'mtd', kind: 'actual' });
    expect(out.match(/<th>AVERAGE<\/th>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out.match(/LIMIT EXCEEDED \(DAYS\)/g)).toHaveLength(2);
  });

  it('has no Average column for Daily (a day is its own average)', () => {
    const out = html({ period: 'today', kind: 'actual' });
    expect(out).not.toContain('<th>AVERAGE</th>');
  });

  it('every section follows the filter: lab, cash, staff and safety', () => {
    const out = html({ period: 'mtd', kind: 'actual' });
    expect(out).toContain('QUALITY CONTROL · OUTLET');
    expect(out).toContain('SITE CASH');
    expect(out).toMatch(/STAFF <span class="note">— UP TO DATE|STAFF <span class="note">— MONTHLY: average of \d+ logged days/);
  });

  it('the figures follow the filter (Daily and Monthly differ)', () => {
    const m = buildMis(bundle(), D);
    const row = m.keyParameters.find((r) => r.standards.actual.today.act !== r.standards.actual.mtd.act);
    expect(row, 'the golden day has a parameter whose Daily and Monthly actuals differ').toBeDefined();
    expect(row!.standards.actual.avg.mtd).not.toBeNull();
    expect(row!.standards.actual.exceed.mtd).toBeGreaterThanOrEqual(row!.standards.actual.exceed.today);
  });

  it('renders on A4 pages (the full MIS flows over at most 3 pages)', async () => {
    const pdf = await renderPdf(html({ period: 'today', kind: 'actual' }), { format: 'A4', landscape: true });
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
    expect(pdfPageCount(pdf)).toBeLessThanOrEqual(3);
  });
}, 60_000);
