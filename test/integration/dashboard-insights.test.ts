import { api, bearer, drainJobs } from '../helpers';
import { livePlant, validValues } from '../phase2-helpers';

interface OvPlant { plantId: string; expected: { date: string; status: string }; primary: { code: string } | null }

async function submitYesterday(p: Awaited<ReturnType<typeof livePlant>>) {
  const L = `/api/v1/plants/${p.plantId}/logsheets`;
  const form = await api().get(`${L}/${p.yesterday}/form`).set(bearer(p.editor.token));
  const values = validValues(form.body.data);
  const draft = await api().put(`${L}/${p.yesterday}`).set(bearer(p.editor.token)).send({ values: values.slice(0, 1), version: 0 });
  const sub = await api().post(`${L}/${p.yesterday}/submit`).set(bearer(p.editor.token)).send({ values, version: draft.body.data.version });
  expect(sub.status).toBe(200);
  await drainJobs();
}

describe('File 2: overview, dashboard alerts/summary, widget layout', () => {
  it('dashboard carries alerts and summary; the overview shows yesterday as submitted', async () => {
    const p = await livePlant();
    await submitYesterday(p);

    const dash = await api().get(`/api/v1/plants/${p.plantId}/dashboard?date=${p.yesterday}`).set(bearer(p.viewer.token));
    expect(dash.status).toBe(200);
    expect(Array.isArray(dash.body.data.alerts)).toBe(true);
    expect(dash.body.data.summary.dataDays.mtd).toBeGreaterThanOrEqual(1);
    expect(dash.body.data.summary.compliance.parameters).toBe(dash.body.data.quality.length);

    const ov = await api().get('/api/v1/overview').set(bearer(p.ca));
    expect(ov.status).toBe(200);
    const mine = (ov.body.data.plants as OvPlant[]).find((x) => x.plantId === p.plantId);
    expect(mine?.expected).toEqual({ date: p.yesterday, status: 'submitted' });
    expect(mine?.primary?.code).toBeTruthy();
    expect(ov.body.data.totals).toMatchObject({ plants: 1, live: 1, expected: 1, submitted: 1 });

    // a Viewer only sees the plants they have a role on
    const ovV = await api().get('/api/v1/overview').set(bearer(p.viewer.token));
    expect((ovV.body.data.plants as OvPlant[]).map((x) => x.plantId)).toEqual([p.plantId]);
  });

  it('widget layout: null by default → saved per user and plant → validated → reset', async () => {
    const p = await livePlant();
    const url = `/api/v1/plants/${p.plantId}/dashboard/layout`;
    const first = await api().get(url).set(bearer(p.viewer.token));
    expect(first.body.data.layout).toBeNull();
    expect(first.body.data.defaults[0]).toBe('kpis');

    const layout = { version: 1, widgets: ['alerts', 'kpis'], focus: 'INFLOW' };
    expect((await api().put(url).set(bearer(p.viewer.token)).send({ layout })).body.data.layout).toEqual(layout);
    expect((await api().get(url).set(bearer(p.viewer.token))).body.data.layout).toEqual(layout);
    expect((await api().get(url).set(bearer(p.editor.token))).body.data.layout).toBeNull(); // per user

    const dup = await api().put(url).set(bearer(p.viewer.token)).send({ layout: { version: 1, widgets: ['kpis', 'kpis'] } });
    expect(dup.status).toBe(400);
    const unknown = await api().put(url).set(bearer(p.viewer.token)).send({ layout: { version: 1, widgets: ['hack'] } });
    expect(unknown.status).toBe(400);
    const extra = await api().put(url).set(bearer(p.viewer.token)).send({ layout: { version: 1, widgets: [], tenantId: 'x' } });
    expect(extra.status).toBe(400);

    expect((await api().delete(url).set(bearer(p.viewer.token))).status).toBe(204);
    expect((await api().get(url).set(bearer(p.viewer.token))).body.data.layout).toBeNull();
  });
});
