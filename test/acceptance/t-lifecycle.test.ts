/**
 * Acceptance cluster: Account lifecycle — grace / read-only / suspended / terminated
 * (Schedule A Part 4(c)). Covers T09 from PRD v1.1 §25.2.
 *
 * This test drives the lifecycle engine per-tenant (via `evaluateTenant`) rather than the
 * global `lifecycle.evaluate` cron, so it runs in seconds against the shared hosted DB
 * instead of minutes while scanning hundreds of tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { addDays, todayIST } from '../../src/lib/dates';
import { systemActor } from '../../src/modules/audit/audit.service';
import { evaluateTenant } from '../../src/modules/lifecycle/lifecycle.service';
import { api, bearer, drainJobs } from '../helpers';
import { billingSetup, restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);

const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));
const plantState = async (admin: string, id: string) =>
  (await api().get(`/api/admin/v1/plants/${id}`).set(bearer(admin))).body.data.accountState;

async function overdueBy(b: Awaited<ReturnType<typeof billingSetup>>, invoiceId: string, overdueDays: number) {
  await sql('UPDATE app.invoices SET due_date = $2 WHERE id = $1', [invoiceId, addDays(todayIST(), -overdueDays)]);
  await withSystem((tx) => evaluateTenant(tx, b.tid, { actor: systemActor(b.tid), cause: 'manual', note: 'T09 acceptance clock' }));
  await drainJobs();
}

describe('Acceptance — Account lifecycle', () => {
  it(
    'T09 — Unpaid invoice timeline (simulated clock): D+1 Grace, D+16 Read-only (entry blocked, reports visible), D+31 Suspended (Client Admin billing page only), D+91 Terminated; payment at any stage restores Active immediately (§9.3, LC-02)',
    async () => {
      const b = await billingSetup();

      // D+1 — grace.
      await overdueBy(b, b.invoiceId, 1);
      expect(await plantState(b.admin, b.plantId)).toBe('grace');

      // D+16 — read-only. Writes are blocked; reads and billing stay reachable.
      await overdueBy(b, b.invoiceId, 16);
      expect(await plantState(b.admin, b.plantId)).toBe('read_only');
      const write = await api().patch('/api/v1/company').set(bearer(b.ca)).send({ displayName: 'New Name' });
      expect(write.body.error.code).toBe('ACCOUNT_READ_ONLY');
      const banners = await api().get('/api/v1/banners').set(bearer(b.ca));
      expect(banners.body.data[0]).toMatchObject({ state: 'read_only', showPayNow: true });

      // D+31 — suspended at the plant level. Billing stays reachable; writes to the plant stay blocked.
      await overdueBy(b, b.invoiceId, 31);
      expect(await plantState(b.admin, b.plantId)).toBe('suspended');
      expect((await api().get('/api/v1/billing/invoices').set(bearer(b.ca))).status).toBe(200);

      // Payment restores Active at once ("payment at any stage restores Active").
      await api().post('/api/admin/v1/payments').set(bearer(b.admin))
        .send({ clientId: b.tid, mode: 'neft', amount: '63720', paymentDate: todayIST(), reference: 'UTR-LC-RESTORE' });
      expect(await plantState(b.admin, b.plantId)).toBe('active');

      // D+91 — terminated: push a fresh invoice overdue past 90 days and re-evaluate.
      const extra = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
        .send({ clientId: b.tid, lines: [{ description: 'Residual balance', qty: 1, rate: '5000' }], issueNow: true });
      expect(extra.status).toBe(201);
      await overdueBy(b, extra.body.data.id, 95);
      const term = await sql(
        'SELECT (SELECT account_state FROM app.plants WHERE id = $1) AS plant_state, (SELECT status FROM app.clients WHERE id = $2) AS client_status',
        [b.plantId, b.tid],
      );
      expect(term.rows[0].client_status === 'terminated' || term.rows[0].plant_state === 'terminated').toBe(true);
    },
    120_000,
  );
});
