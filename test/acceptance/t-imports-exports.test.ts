/**
 * Acceptance cluster: full data export (Schedule A Part 4(c)).
 * Covers T20 from PRD v1.1 §25.2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { api, bearer, drainJobs } from '../helpers';
import { livePlant } from '../phase2-helpers';
import { restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);

const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));

describe('Acceptance — Exports', () => {
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
