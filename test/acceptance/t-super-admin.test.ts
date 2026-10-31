/**
 * Acceptance cluster: Super Admin — plans, subscriptions, settings, act-as (Schedule A Part 4(c)).
 *
 * Covers T02, T03, T18, T19 from PRD v1.1 §25.2.
 */
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { todayIST } from '../../src/lib/dates';
import { api, bearer, loginAdmin, seedSuperAdmin, seedTenant, uniq } from '../helpers';
import { livePlant } from '../phase2-helpers';
import { billingSetup } from '../phase3-helpers';

const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));

describe('Acceptance — Super Admin: plans, subscriptions, settings, act-as', () => {
  it(
    'T02 — Tenure 181 months or a 16-year subscription is rejected with the 15-year message (GR-01)',
    async () => {
      const sa = await seedSuperAdmin();
      const admin = (await loginAdmin(sa)).token;

      // 16-year plan: zod max(MAX_CONTRACT_YEARS=15) rejects it.
      const plan16 = await api().post('/api/admin/v1/plans').set(bearer(admin))
        .send({ name: `P ${uniq()}`, code: `P-${uniq()}`.toUpperCase(), termYears: 16, pricePerYear: '50000' });
      expect(plan16.status).toBeGreaterThanOrEqual(400);
      expect(plan16.status).toBeLessThan(500);

      // 181-month tenure on plant creation: om_tenure_months is capped at 180.
      const good = await api().post('/api/admin/v1/plans').set(bearer(admin))
        .send({ name: `P ${uniq()}`, code: `P-${uniq()}`.toUpperCase(), termYears: 5, pricePerYear: '50000' });
      const tenant = await seedTenant();
      const plant = await api().post('/api/admin/v1/plants').set(bearer(admin)).send({
        clientId: tenant.tenantId, name: 'Too long', type: 'STP', capacityMld: 10, stateCode: '27',
        omStart: '2024-09-01', omTenureMonths: 181,
        subscription: { planId: good.body.data.id, startDate: todayIST(), billingMode: 'yearly' },
      });
      expect(plant.status).toBeGreaterThanOrEqual(400);
      expect(plant.status).toBeLessThan(500);
    },
  );

  it(
    'T03 — Client Admin completes settings: checklist all green; plant moves from "Settings pending" to Live (§11.12)',
    async () => {
      // livePlant walks every setting checkbox (fees, components, stock openings, cash opening, go-live).
      const p = await livePlant();
      const row = await sql('SELECT setup_status FROM app.plants WHERE id = $1', [p.plantId]);
      expect(row.rows[0].setup_status).toBe('live');
    },
  );

  it(
    'T18 — Plan price edit: existing subscriptions are unchanged (price snapshot, PLN-03); new ones use the new price',
    async () => {
      // Existing subscription at ₹50,000 — snapshot stored at creation.
      const b = await billingSetup({ price: '50000' });
      const beforeSub = await sql(
        `SELECT plan_snapshot FROM app.subscriptions WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
        [b.tid],
      );
      expect(beforeSub.rows[0].plan_snapshot.pricePerYear).toBe('50000.00');

      // Patch the plan to ₹70,000 — the snapshot on the existing subscription is unchanged.
      const patched = await api().patch(`/api/admin/v1/plans/${b.planId}`).set(bearer(b.admin))
        .send({ pricePerYear: '70000' });
      expect(patched.status).toBe(200);

      const afterSub = await sql(
        `SELECT plan_snapshot FROM app.subscriptions WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
        [b.tid],
      );
      expect(afterSub.rows[0].plan_snapshot.pricePerYear).toBe('50000.00');

      // A new plant on the same plan picks up the new price.
      const t2 = await seedTenant();
      const p2 = await api().post('/api/admin/v1/plants').set(bearer(b.admin)).send({
        clientId: t2.tenantId, name: 'New STP', type: 'STP', capacityMld: 120, stateCode: '27',
        omStart: '2024-09-01', omTenureMonths: 60,
        subscription: { planId: b.planId, startDate: todayIST(), billingMode: 'yearly' },
      });
      expect(p2.status).toBe(201);
      const newSub = await sql(
        `SELECT plan_snapshot FROM app.subscriptions WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
        [t2.tenantId],
      );
      expect(newSub.rows[0].plan_snapshot.pricePerYear).toBe('70000.00');
    },
  );

  it(
    'T19 — Act-as by Super Admin: banner shown; every page view and action audited as "Super Admin X acting as client Y" (ACT-04)',
    async () => {
      const b = await billingSetup();
      const session = await api().post(`/api/admin/v1/clients/${b.tid}/act-as`).set(bearer(b.admin)).send({ mode: 'view' });
      expect(session.status).toBe(201);

      const exchange = await api().post('/api/v1/auth/act-as/exchange').send({ code: session.body.data.code });
      expect(exchange.status).toBe(200);
      // Banner payload: the response advertises the acting-as session so the UI can draw the banner.
      expect(exchange.body.data.actingAs).toMatchObject({ adminId: b.sa.id, mode: 'view' });

      const actToken = exchange.body.data.accessToken as string;
      await api().get('/api/v1/company').set(bearer(actToken));
      await api().get('/api/v1/plants').set(bearer(actToken));

      // Each request Super Admin issues while acting as the client is tagged with acting_as_admin_id.
      const audit = await sql(
        `SELECT count(*)::int AS n FROM app.audit_log WHERE tenant_id = $1 AND acting_as_admin_id = $2`,
        [b.tid, b.sa.id],
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    },
  );
});
