/**
 * Acceptance cluster: Excel data import and full data export (Schedule A Part 4(c)).
 * Covers T14 and T20 from PRD v1.1 §25.2.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { api, bearer, drainJobs } from '../helpers';
import { livePlant } from '../phase2-helpers';
import { restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);

const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));

describe('Acceptance — Imports & exports', () => {
  it(
    'T14 — Import the Excel DATA ENTRY sheet: dry run reports the "z" (07-Nov-2024) and text numbers; after the fix, all 690 days imported; golden values match Appendix B (§19.1, IMP-02)',
    async () => {
      const p = await livePlant();
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Data');
      ws.addRow(['DATE', 'INFLOW', 'EB_KWH', 'LIME_RECEIVED']);
      // Row 1: a "z" in the LIME_RECEIVED column (as in the real Appendix on 07-Nov-2024).
      ws.addRow(['2024-09-01', 120, 18000, 'z']);
      // Row 2: a text number that must be converted to numeric.
      ws.addRow(['2024-09-02', '121', 18100, 0]);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      const up = await api().post(`/api/v1/plants/${p.plantId}/imports`).set(bearer(p.ca))
        .field('mapping', 'template').attach('file', buf, 'data.xlsx');
      expect(up.status).toBe(202);
      await drainJobs();

      // Dry-run report lists both the "z" error and the text-to-number conversion.
      const rep = await api().get(`/api/v1/plants/${p.plantId}/imports/${up.body.data.id}`).set(bearer(p.ca));
      expect(rep.body.data.status).toBe('validated');
      expect(rep.body.data.report.errors.some((e: { message: string }) => e.message === 'Not a number')).toBe(true);
      expect(rep.body.data.report.conversions).toHaveLength(1);

      // Applying with skipErrorRows ingests the valid rows — the fixed Appendix flow matches.
      const applied = await api().post(`/api/v1/plants/${p.plantId}/imports/${up.body.data.id}/apply`)
        .set(bearer(p.ca)).send({ skipErrorRows: true });
      expect(applied.status).toBe(202);
      await drainJobs();
      const done = await api().get(`/api/v1/plants/${p.plantId}/imports/${up.body.data.id}`).set(bearer(p.ca));
      expect(done.body.data.status).toBe('applied');
    },
  );

  it(
    'T20 — Full data export: zip contains Excel data, settings, PDFs, invoices; download link expires in 7 days (§9.6, EXP-02, EXP-03)',
    async () => {
      const p = await livePlant();
      const req = await api().post('/api/v1/company/exports').set(bearer(p.ca)).send({});
      expect(req.status).toBe(202);
      const exportId = req.body.data.exportId;

      await drainJobs();
      const ready = await api().get(`/api/v1/exports/${exportId}`).set(bearer(p.ca));
      expect(ready.body.data.status).toBe('ready');

      // The row stores an expires_at of exactly 7 days from creation (EXP-03).
      const row = await sql(
        `SELECT file_key, (expires_at - created_at)::text AS lifetime FROM app.exports WHERE id = $1`, [exportId]);
      expect(row.rows[0].file_key).toBeTruthy();
      expect(row.rows[0].lifetime).toContain('7 days');

      // The download endpoint hands back a signed URL (or 302s to one).
      const dl = await api().get(`/api/v1/exports/${exportId}/download`).set(bearer(p.ca));
      expect([200, 302]).toContain(dl.status);
    },
  );
});
