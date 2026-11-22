import { afterAll, describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import { closeBrowser, pdfPageCount, renderPdf } from '../../src/modules/pdf/browser';
import { misHtml } from '../../src/modules/pdf/templates/mis';
import { goldenInput } from '../golden/fixture';

afterAll(closeBrowser);

const META = { version: 1, platform: 'OMMIS Test' };
/** Any date for which the golden fixture has data — all three cases use the same date for determinism. */
const D = '2026-09-21';

async function render(bundle: Bundle, date: string): Promise<number> {
  const html = misHtml(buildMis(bundle, date), META);
  const pdf = await renderPdf(html, { format: 'A4', landscape: true });
  return pdfPageCount(pdf);
}

/** The simple MIS PDF: one page per standard shown plus one page for quality/guarantees/cash/staff, never blank. */
describe('MIS PDF — simple layout', () => {
  it('renders without a blank page (maintenance on, golden data)', async () => {
    const { settings, data } = goldenInput();
    const on = { ...settings, maintenance: { ...settings.maintenance, enabled: true } };
    const bundle: Bundle = { settings: on, data, derived: computeDerived(on, data, D) };
    const pages = await render(bundle, D);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThanOrEqual(6);
  });

  it('one standard shown renders fewer pages than both', async () => {
    const { settings, data } = goldenInput();
    const both = { ...settings, standardsShown: 'both' as const };
    const one = { ...settings, standardsShown: 'actual' as const };
    const pBoth = await render({ settings: both, data, derived: computeDerived(both, data, D) }, D);
    const pOne = await render({ settings: one, data, derived: computeDerived(one, data, D) }, D);
    expect(pOne).toBeLessThan(pBoth);
  });

  it('renders when every register is empty', async () => {
    const { settings, data } = goldenInput();
    const stripped = { ...settings, registers: [] };
    const pages = await render({ settings: stripped, data, derived: computeDerived(stripped, data, D) }, D);
    expect(pages).toBeGreaterThanOrEqual(2);
  });
}, 60_000);
