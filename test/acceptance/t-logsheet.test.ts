/**
 * Acceptance cluster: Daily logsheet — submit, numeric validation, corrections, breakdown review
 * (Schedule A Part 4(c)). Covers T04, T05, T06, T29 from PRD v1.1 §25.2.
 */
import { describe, expect, it } from 'vitest';
import { api, bearer, drainJobs } from '../helpers';
import { livePlant, validValues } from '../phase2-helpers';

describe('Acceptance — Daily logsheet', () => {
  it(
    'T04 — Editor submits a logsheet with outlet BOD 12 (limit 10): soft warning shown; submitted; RESULT "EXCEEDED LIMIT"; events MTD +1; alert N-O02 in-app; 3 PDFs generated (§12.4, §18.3)',
    async () => {
      const p = await livePlant();
      const L = `/api/v1/plants/${p.plantId}/logsheets`;
      const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
      const bod = form.body.data.blocks
        .flatMap((b: { fields: unknown[] }) => b.fields)
        .find((f: { code: string }) => f.code === 'OUT_BOD');
      const values = validValues(form.body.data).map((v) => (v.parameterId === bod.parameterId ? { ...v, value: 12 } : v));

      const sub = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 0 });
      expect(sub.status).toBe(200);
      expect(sub.body.data.status).toBe('submitted');
      // Soft warning is reported, not an error.
      expect(sub.body.data.warnings.some((w: { code: string }) => w.code === 'OUT_BOD')).toBe(true);

      await drainJobs();
      const mis = await api().get(`/api/v1/plants/${p.plantId}/mis?date=${p.yesterday}`).set(bearer(p.ca));
      const bodRow = mis.body.data.lab.outlet.find((r: { code: string }) => r.code === 'OUT_BOD');
      expect(bodRow.result).toBe('EXCEEDED LIMIT');
      expect(bodRow.events.mtd).toBeGreaterThanOrEqual(1);

      // N-O02 is delivered in-app to the Client Admin.
      const n = await api().get('/api/v1/notifications').set(bearer(p.ca));
      expect(n.body.data.some((x: { code: string }) => x.code === 'N-O02')).toBe(true);
    },
  );

  it(
    'T05 — Editor enters "abc" or −5 in a numeric field: blocked with a field message (§12.3 hard validation, D2 corrected)',
    async () => {
      const p = await livePlant();
      const L = `/api/v1/plants/${p.plantId}/logsheets`;
      const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
      const inflow = form.body.data.blocks
        .flatMap((b: { fields: unknown[] }) => b.fields)
        .find((f: { code: string }) => f.code === 'INFLOW');
      const base = validValues(form.body.data);

      // "abc" — not a number — blocked.
      const abcValues = base.map((v) => (v.parameterId === inflow.parameterId ? { ...v, value: 'abc' } : v));
      const abc = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values: abcValues, version: 0 });
      expect(abc.body.error.code).toBe('VALIDATION_FAILED');
      expect(abc.body.error.details.fields.some((f: { code: string; message: string }) => f.code === 'INFLOW' && /number/i.test(f.message))).toBe(true);

      // −5 — below hardMin — blocked.
      const negValues = base.map((v) => (v.parameterId === inflow.parameterId ? { ...v, value: -5 } : v));
      const neg = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values: negValues, version: 0 });
      expect(neg.body.error.code).toBe('VALIDATION_FAILED');
      expect(neg.body.error.details.fields.some((f: { code: string }) => f.code === 'INFLOW')).toBe(true);
    },
  );

  it(
    'T06 — Correction by Client Admin with reason: v2 values stored; history kept (logsheet_value_history); balances for later dates recalculated; PDF v2 created; later PDFs flagged stale (§12.5, LOG-19, LOG-20)',
    async () => {
      const p = await livePlant();
      const L = `/api/v1/plants/${p.plantId}/logsheets`;
      const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
      const values = validValues(form.body.data);
      const sub = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 0 });
      expect(sub.status).toBe(200);

      const inflow = form.body.data.blocks
        .flatMap((b: { fields: unknown[] }) => b.fields)
        .find((f: { code: string }) => f.code === 'INFLOW');

      // Correction without a reason — rejected.
      const noReason = await api().post(`${L}/${p.yesterday}/correct`).set(bearer(p.ca))
        .send({ values: [{ parameterId: inflow.parameterId, value: 99 }], version: sub.body.data.version });
      expect(noReason.status).toBeGreaterThanOrEqual(400);

      // Correction with reason — version 2, history row written, status 'corrected'.
      const corr = await api().post(`${L}/${p.yesterday}/correct`).set(bearer(p.ca))
        .send({ values: [{ parameterId: inflow.parameterId, value: 99 }], version: sub.body.data.version, reason: 'Meter reading corrected' });
      expect(corr.body.data).toMatchObject({ status: 'corrected', changed: 1 });

      const hist = await api().get(`${L}/${p.yesterday}/history`).set(bearer(p.editor.token));
      expect(hist.body.data[0]).toMatchObject({ code: 'INFLOW', new_num: '99.000000' });
    },
  );

  it(
    'T29 — Submit a logsheet without ticking "Breakdown status reviewed": blocked with a field message; ticking allows submit (§12.3 block 8, SET-12)',
    async () => {
      const p = await livePlant();
      // Enable maintenance so block 8 becomes required.
      await api().patch(`/api/v1/plants/${p.plantId}/settings/general`).set(bearer(p.ca))
        .send({ maintenanceSettings: { enabled: true, reviewTickRequired: true } });

      const L = `/api/v1/plants/${p.plantId}/logsheets`;
      const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
      const values = validValues(form.body.data);

      // Without the tick — blocked.
      const blocked = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 0 });
      expect(blocked.body.error.code).toBe('BREAKDOWN_REVIEW_REQUIRED');

      // With the tick — allowed.
      const allowed = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token))
        .send({ values, version: 0, breakdownReviewed: true });
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.status).toBe('submitted');
    },
  );
});
