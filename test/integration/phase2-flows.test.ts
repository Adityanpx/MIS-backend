import { withSystem } from '../../src/db/tenant';
import { api, bearer, drainJobs } from '../helpers';
import { livePlant, validValues } from '../phase2-helpers';

describe('settings', () => {
  it('template applied on STP creation, go-live, formula validation, backdated change needs a reason', async () => {
    const p = await livePlant();
    const base = `/api/v1/plants/${p.plantId}/settings`;
    const params = await api().get(`${base}/parameters`).set(bearer(p.ca));
    expect(params.body.data.length).toBeGreaterThan(40);
    const bad = await api().post(`${base}/parameters`).set(bearer(p.ca)).send({
      code: 'LOOP_A', name: 'Loop', groupKey: 'other', unit: 'x', inputMode: 'calculated', formula: 'LOOP_A + 1',
      aggregation: 'sum', stdType: 'none', direction: 'neutral', eventRule: 'none' });
    expect(bad.body.error.code).toBe('INVALID_FORMULA');
    const eb = params.body.data.find((x: { code: string }) => x.code === 'EB_KWH');
    const noReason = await api().post(`${base}/parameters/${eb.id}/standards`).set(bearer(p.ca)).send({ std: 19000, effectiveFrom: '2025-01-01' });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const ok = await api().post(`${base}/parameters/${eb.id}/standards`).set(bearer(p.ca))
      .send({ std: 19000, effectiveFrom: '2025-01-01', reason: 'Authority revised the EB standard' });
    expect(ok.status).toBe(200);
    // Editors read settings; Viewers can't; Editors can't write
    expect((await api().get(`${base}/general`).set(bearer(p.editor.token))).status).toBe(200);
    expect((await api().get(`${base}/general`).set(bearer(p.viewer.token))).status).toBe(403);
    expect((await api().patch(`${base}/general`).set(bearer(p.editor.token)).send({ tagline: 'x' })).status).toBe(403);
  });
});

describe('logsheets', () => {
  it('draft → submit → MIS → correction with history; versions and locks', async () => {
    const p = await livePlant();
    const L = `/api/v1/plants/${p.plantId}/logsheets`;
    const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
    expect(form.body.data.rule.allowed).toBe(true);
    const values = validValues(form.body.data);
    const draft = await api().put(`${L}/${p.yesterday}`).set(bearer(p.editor.token)).send({ values: values.slice(0, 3), version: 0 });
    expect(draft.body.data.version).toBe(1);
    expect((await api().put(`${L}/${p.yesterday}`).set(bearer(p.editor.token)).send({ values: [], version: 0 })).body.error.code).toBe('STALE_VERSION');
    expect((await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.viewer.token)).send({ values, version: 1 })).status).toBe(403);
    const sub = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 1 });
    expect(sub.status).toBe(200);
    expect(sub.body.data.status).toBe('submitted');
    expect((await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 2 })).body.error.code)
      .toBe('LOGSHEET_ALREADY_SUBMITTED');
    await drainJobs();
    const mis = await api().get(`/api/v1/plants/${p.plantId}/mis?date=${p.yesterday}`).set(bearer(p.viewer.token));
    expect(mis.status).toBe(200);
    expect(mis.body.data.header.logsheet.status).toBe('submitted');
    const inflow = form.body.data.blocks.flatMap((b: { fields: unknown[] }) => b.fields).find((f: { code: string }) => f.code === 'INFLOW');
    const corr = await api().post(`${L}/${p.yesterday}/correct`).set(bearer(p.ca))
      .send({ values: [{ parameterId: inflow.parameterId, value: 99 }], version: sub.body.data.version, reason: 'Meter reading corrected' });
    expect(corr.body.data).toMatchObject({ status: 'corrected', changed: 1 });
    const hist = await api().get(`${L}/${p.yesterday}/history`).set(bearer(p.editor.token));
    expect(hist.body.data[0]).toMatchObject({ code: 'INFLOW', new_num: '99.000000' });
    await drainJobs();
    const derived = await withSystem((tx) => tx.query('SELECT count(*)::int AS n FROM app.daily_derived WHERE plant_id = $1', [p.plantId]));
    expect(derived.rows[0].n).toBeGreaterThan(0);
  });

  it('hard validation and the edit lock', async () => {
    const p = await livePlant();
    const L = `/api/v1/plants/${p.plantId}/logsheets`;
    const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
    const values = validValues(form.body.data).map((v) => ({ ...v }));
    const ph = form.body.data.blocks.flatMap((b: { fields: unknown[] }) => b.fields).find((f: { code: string }) => f.code === 'OUT_PH');
    const bad = values.map((v) => (v.parameterId === ph.parameterId ? { ...v, value: 15 } : v));
    const r = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values: bad, version: 0 });
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect((await api().post(`${L}/${p.yesterday}/lock`).set(bearer(p.editor.token))).status).toBe(200);
    const other = await api().post(`${L}/${p.yesterday}/lock`).set(bearer(p.ca));
    expect(other.body.error.code).toBe('LOGSHEET_LOCKED');
  });

  it('outlet exceedance notifies the Client Admin (N-O02); reports export to Excel', async () => {
    const p = await livePlant();
    const L = `/api/v1/plants/${p.plantId}/logsheets`;
    const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
    const bod = form.body.data.blocks.flatMap((b: { fields: unknown[] }) => b.fields).find((f: { code: string }) => f.code === 'OUT_BOD');
    const values = validValues(form.body.data).map((v) => (v.parameterId === bod.parameterId ? { ...v, value: 25 } : v));
    const sub = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: 0 });
    expect(sub.body.data.warnings.some((w: { code: string }) => w.code === 'OUT_BOD')).toBe(true);
    const n = await api().get('/api/v1/notifications').set(bearer(p.ca));
    expect(n.body.data.some((x: { code: string }) => x.code === 'N-O02')).toBe(true);
    await drainJobs();
    const x = await api().get(`/api/v1/plants/${p.plantId}/reports/lab-compliance?from=${p.yesterday}&to=${p.yesterday}&format=xlsx`).set(bearer(p.viewer.token));
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
  });
});

