/**
 * Excel import at real-world size: a 365-day file is saved in one go (batched writes), a re-import is
 * recorded as corrections with history, and a second concurrent save is refused instead of hanging.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { api, bearer } from '../helpers';
import { livePlant, validValues } from '../phase2-helpers';

const FROM = '2024-09-01';
const TO = '2025-08-31'; // 365 days

/** supertest parser that keeps the .xlsx download as raw bytes. */
const binary = (res: unknown, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as NodeJS.ReadableStream; // reason: at runtime the response is the raw http.IncomingMessage stream
  const parts: Buffer[] = [];
  stream.on('data', (c: Buffer) => parts.push(c));
  stream.on('end', () => cb(null, Buffer.concat(parts)));
};

/** Fill every editable cell of the downloaded template; `remarks` goes into the REMARKS column. */
async function fill(template: Buffer, byId: Map<string, number | string | null>, remarks: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // reason: exceljs' Buffer typing predates @types/node's generic Buffer; the bytes are the same.
  await wb.xlsx.load(template as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Logsheets')!;
  const cols: Array<{ col: number; code: string; id: string }> = [];
  wb.getWorksheet('_meta')!.eachRow((r) => {
    const v = r.values as unknown[];
    if (typeof v[1] === 'number') cols.push({ col: v[1], code: String(v[2]), id: String(v[3]) });
  });
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.getCell(1).value) continue;
    for (const c of cols) {
      const cell = row.getCell(c.col);
      if (cell.protection?.locked !== false) continue;
      cell.value = c.code === 'REMARKS' ? remarks : (byId.get(c.id) ?? null);
    }
    row.commit();
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('logsheet Excel import at scale', () => {
  it('saves 365 days in one request, re-import becomes corrections, concurrent save is refused', async () => {
    const lp = await livePlant();
    const base = `/api/v1/plants/${lp.plantId}/logsheets`;
    const form = await api().get(`${base}/${FROM}/form`).set(bearer(lp.ca));
    expect(form.status).toBe(200);
    const byId = new Map(validValues(form.body.data).map((v) => [v.parameterId, v.value]));

    const tpl = await api().get(`${base}/import/template?from=${FROM}&to=${TO}`).set(bearer(lp.ca))
      .buffer(true).parse(binary);
    expect(tpl.status).toBe(200);
    const file1 = await fill(tpl.body as Buffer, byId, 'first import');

    const pv = await api().post(`${base}/import/preview`).set(bearer(lp.ca)).attach('file', file1, 'logsheet.xlsx');
    expect(pv.status).toBe(200);
    expect(pv.body.data).toMatchObject({ rows: 365, rowsReady: 365 });
    expect(pv.body.data.errors).toEqual([]);

    const t0 = Date.now();
    const run = await api().post(`${base}/import`).set(bearer(lp.ca))
      .field('conflict', 'use_excel').attach('file', file1, 'logsheet.xlsx');
    const elapsed = Date.now() - t0;
    expect(run.status).toBe(200);
    expect(run.body.data).toMatchObject({ saved: 365, inserted: 365, corrected: 0, skipped: 0 });
    expect(elapsed).toBeLessThan(60_000); // was > 100 s for 270 days before batching

    const counts = await withSystem(async (tx) => (await tx.query<{ days: number; vals: number; remarks: number }>(
      `SELECT count(DISTINCT l.id)::int AS days, count(v.id)::int AS vals,
              count(*) FILTER (WHERE v.value_text = 'first import')::int AS remarks
         FROM app.logsheets l LEFT JOIN app.logsheet_values v ON v.tenant_id = l.tenant_id AND v.logsheet_id = l.id
        WHERE l.tenant_id = $1 AND l.plant_id = $2 AND l.log_date BETWEEN $3 AND $4 AND l.source = 'import'`,
      [lp.tenant.tenantId, lp.plantId, FROM, TO])).rows[0]!);
    expect(counts.days).toBe(365);
    expect(counts.remarks).toBe(365);
    expect(counts.vals).toBeGreaterThan(365 * 20);

    // Re-import with a changed remark: every day becomes a correction with one history row each.
    const file2 = await fill(tpl.body as Buffer, byId, 'second import');
    const again = await api().post(`${base}/import`).set(bearer(lp.ca))
      .field('conflict', 'use_excel').attach('file', file2, 'logsheet.xlsx');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ saved: 365, inserted: 0, corrected: 365 });
    const hist = await withSystem(async (tx) => (await tx.query<{ n: number; corrected: number; v2: number }>(
      `SELECT (SELECT count(*)::int FROM app.logsheet_value_history h JOIN app.logsheets l ON l.tenant_id = h.tenant_id AND l.id = h.logsheet_id
                WHERE l.tenant_id = $1 AND l.plant_id = $2 AND h.old_text = 'first import' AND h.new_text = 'second import') AS n,
              count(*) FILTER (WHERE status = 'corrected')::int AS corrected,
              count(*) FILTER (WHERE version = 2)::int AS v2
         FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 AND log_date BETWEEN $3 AND $4`,
      [lp.tenant.tenantId, lp.plantId, FROM, TO])).rows[0]!);
    expect(hist).toEqual({ n: 365, corrected: 365, v2: 365 });

    // keep_existing skips every already-submitted day.
    const keep = await api().post(`${base}/import`).set(bearer(lp.ca))
      .field('conflict', 'keep_existing').attach('file', file1, 'logsheet.xlsx');
    expect(keep.body.data).toMatchObject({ saved: 0, skipped: 365 });

    // While another save holds the plant's import lock, a second one is refused at once (409), not hung.
    await withSystem(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`logsheet-import:${lp.plantId}`]);
      const busy = await api().post(`${base}/import`).set(bearer(lp.ca))
        .field('conflict', 'use_excel').attach('file', file1, 'logsheet.xlsx');
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('IMPORT_IN_PROGRESS');
    });
  }, 300_000);
});
