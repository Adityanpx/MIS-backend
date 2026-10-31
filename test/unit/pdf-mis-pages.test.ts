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

/** Schedule A Part 4(d): "The MIS PDF has exactly 5 pages." The three cases together prove the
 *  page count is invariant across the configurations the clause has to hold for. */
describe('MIS PDF — Schedule A Part 4(d): exactly 5 pages', () => {
  it('5 pages when the plant has maintenance ON and data for every tab', async () => {
    const { settings, data } = goldenInput();
    const settingsOn = { ...settings, maintenance: { ...settings.maintenance, enabled: true } };
    const bundle: Bundle = { settings: settingsOn, data, derived: computeDerived(settingsOn, data, D) };
    expect(await render(bundle, D)).toBe(5);
  });

  it('5 pages when the plant has maintenance OFF (page 5 shows the placeholder)', async () => {
    const { settings, data } = goldenInput();
    const settingsOff = { ...settings, maintenance: { ...settings.maintenance, enabled: false } };
    const bundle: Bundle = { settings: settingsOff, data, derived: computeDerived(settingsOff, data, D) };
    expect(await render(bundle, D)).toBe(5);
  });

  it('5 pages when every register is empty (no BGs, no insurance, no breakdowns)', async () => {
    const { settings, data } = goldenInput();
    const stripped = { ...settings, registers: [], maintenance: { ...settings.maintenance, enabled: true } };
    const bundle: Bundle = { settings: stripped, data, derived: computeDerived(stripped, data, D) };
    expect(await render(bundle, D)).toBe(5);
  });
}, 60_000);
