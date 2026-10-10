import { applyTemplate } from '../../src/modules/settings/apply-template';
import { withSystem } from '../../src/db/tenant';
import { clientApiRouter } from '../../src/routes/client.routes';
import { api, bearer, loginClient, seedPlant, seedTenant, seedUser, uniq } from '../helpers';
import { CASES, CASES_P2, CASES_P3, EXEMPT, fillPlantRoute, type Attacker, type Victim } from './cases';
import { listRoutes } from './routes';

/** Everything of tenant B that an attack could change. */
async function snapshot(tenantId: string): Promise<string> {
  return withSystem(async (tx) => {
    const q = async (sql: string) => (await tx.query(sql, [tenantId])).rows;
    return JSON.stringify({
      client: await q('SELECT display_name, logo_key, billing_emails, terms_version FROM app.clients WHERE id = $1'),
      users: await q('SELECT id, name, status, is_client_admin, token_version FROM app.users WHERE tenant_id = $1 ORDER BY id'),
      roles: await q('SELECT user_id, plant_id, role FROM app.user_plant_roles WHERE tenant_id = $1 ORDER BY user_id, plant_id'),
      plants: await q('SELECT id, name, account_state FROM app.plants WHERE tenant_id = $1 ORDER BY id'),
      tokens: await q('SELECT count(*) AS n FROM app.auth_tokens WHERE tenant_id = $1'),
      parameters: await q('SELECT id, name FROM app.parameters WHERE tenant_id = $1 ORDER BY id'),
      stock_items: await q('SELECT id, name FROM app.stock_items WHERE tenant_id = $1 ORDER BY id'),
      bank_guarantees: await q('SELECT id, label FROM app.bank_guarantees WHERE tenant_id = $1 ORDER BY id'),
      notifications: await q('SELECT id, read_at FROM app.notifications WHERE tenant_id = $1 ORDER BY id'),
      correction_requests: await q('SELECT id, status FROM app.correction_requests WHERE tenant_id = $1 ORDER BY id'),
    });
  });
}

describe('tenant isolation harness', () => {
  it('every /api/v1 route has an isolation case or a documented exemption', () => {
    const covered = new Set([...CASES.map((c) => c.route), ...Object.keys(EXEMPT)]);
    const missing = listRoutes(clientApiRouter).filter((r) => !covered.has(r) && !/^[A-Z]+ \/plants\/:plantId\//.test(r));
    expect(missing, `Add isolation cases in test/isolation/cases.ts for: ${missing.join(', ')}`).toEqual([]);
  });

  it("tenant A's Client Admin cannot read or change anything of tenant B", async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    const aPlant = await seedPlant(A.tenantId);
    const bPlant = await seedPlant(B.tenantId);
    const aUser = await seedUser(A.tenantId, [{ plantId: aPlant, role: 'viewer' }]);
    const bUser = await seedUser(B.tenantId, [{ plantId: bPlant, role: 'editor' }]);
    const victim: Victim = { tenantId: B.tenantId, plantId: bPlant, userId: bUser.id, adminId: B.admin.id };
    const attacker: Attacker = { plantId: aPlant, userId: aUser.id };
    const { token } = await loginClient(A.admin.email);
    const before = await snapshot(B.tenantId);

    for (const c of CASES) {
      const req = api()[c.method](`/api/v1${c.path(victim, attacker)}`).set(bearer(token));
      const res = c.body ? await req.send(c.body(victim, attacker)) : await req;
      expect(res.status, `${c.route} → ${res.status} ${JSON.stringify(res.body)}`).toBe(c.expectStatus ?? 404);
    }
    expect(await snapshot(B.tenantId)).toBe(before);

    // list endpoints never contain B's rows
    const text = JSON.stringify([
      (await api().get('/api/v1/plants').set(bearer(token))).body,
      (await api().get('/api/v1/company/users?pageSize=100').set(bearer(token))).body,
      (await api().get('/api/v1/company/audit?pageSize=100').set(bearer(token))).body,
      (await api().get('/api/v1/company').set(bearer(token))).body,
      (await api().get('/api/v1/me').set(bearer(token))).body,
    ]);
    for (const id of [B.tenantId, bPlant, bUser.id, B.admin.id, B.admin.email]) expect(text).not.toContain(id);
  });

  it('a user without a role on a plant of the SAME tenant gets 404, not 403', async () => {
    const A = await seedTenant();
    const p1 = await seedPlant(A.tenantId);
    const p2 = await seedPlant(A.tenantId);
    const u = await seedUser(A.tenantId, [{ plantId: p1, role: 'viewer' }]);
    const { token } = await loginClient(u.email);
    expect((await api().get(`/api/v1/plants/${p2}`).set(bearer(token))).status).toBe(404);
    expect((await api().get('/api/v1/plants/not-a-uuid').set(bearer(token))).status).toBe(404);
  });

  it('Phase 2: every plant-scoped route rejects the victim plant, and sub-resources of the victim are invisible', async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    const aPlant = await seedPlant(A.tenantId);
    const bPlant = await seedPlant(B.tenantId);
    const ids = await withSystem(async (tx) => {
      await applyTemplate(tx, B.tenantId, bPlant, '2024-09-01', null);
      await applyTemplate(tx, A.tenantId, aPlant, '2024-09-01', null);
      const q = async (sql: string, p: unknown[]) => (await tx.query<{ id: string }>(sql, p)).rows[0]!.id;
      const paramId = await q('SELECT id FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 LIMIT 1', [B.tenantId, bPlant]);
      const stockItemId = await q('SELECT id FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2 LIMIT 1', [B.tenantId, bPlant]);
      const bgId = await q(`INSERT INTO app.bank_guarantees (tenant_id, plant_id, label, bg_number, bank, start_date, end_date, amount)
        VALUES ($1, $2, 'BG-1', 'X1', 'Bank', '2024-01-01', '2027-01-01', 1000) RETURNING id`, [B.tenantId, bPlant]);
      const notificationId = await q(`INSERT INTO app.notifications (tenant_id, user_id, template_code, title, body)
        VALUES ($1, $2, 'N-O01', 't', 'b') RETURNING id`, [B.tenantId, B.admin.id]);
      const exportId = await q(`INSERT INTO app.exports (tenant_id, scope, status, file_key, created_by)
        VALUES ($1, '{}'::jsonb, 'ready', $3, $2) RETURNING id`, [B.tenantId, B.admin.id, `t/${B.tenantId}/exports/x.zip`]);
      const pdfId = await q(`INSERT INTO app.pdf_documents (tenant_id, plant_id, d, doc_type, version, file_key, status)
        VALUES ($1, $2, '2025-01-01', 'mis', 1, $3, 'current') RETURNING id`, [B.tenantId, bPlant, `t/${B.tenantId}/p/${bPlant}/x.pdf`]);
      const importId = await q(`INSERT INTO app.imports (tenant_id, plant_id, file_key, mapping) VALUES ($1, $2, 'k', 'template') RETURNING id`, [B.tenantId, bPlant]);
      const sheet = await q(`INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status) VALUES ($1, $2, '2025-01-01', 'submitted') RETURNING id`, [B.tenantId, bPlant]);
      const correctionId = await q(`INSERT INTO app.correction_requests (tenant_id, logsheet_id, requested_by, reason, proposed)
        VALUES ($1, $2, $3, 'reason text', '[]'::jsonb) RETURNING id`, [B.tenantId, sheet, B.admin.id]);
      return { paramId, stockItemId, bgId, notificationId, exportId, pdfId, importId, correctionId };
    });
    const victim = { tenantId: B.tenantId, plantId: bPlant, userId: B.admin.id, adminId: B.admin.id, ...ids };
    const { token } = await loginClient(A.admin.email);
    const before = await snapshot(B.tenantId);
    for (const route of listRoutes(clientApiRouter).filter((r) => /^[A-Z]+ \/plants\/:plantId\//.test(r))) {
      const c = fillPlantRoute(route, victim);
      const res = await api()[c.method](`/api/v1${c.path}`).set(bearer(token)).send({});
      expect(res.status, `${route} → ${res.status}`).toBe(404);
    }
    for (const c of CASES_P2(victim, { plantId: aPlant, userId: A.admin.id })) {
      const res = await api()[c.method](`/api/v1${c.path}`).set(bearer(token)).send(c.body ?? {});
      expect(res.status, `${c.method} ${c.path} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404);
    }
    expect(await snapshot(B.tenantId)).toBe(before);
  });

  it('Phase 3: billing documents of another tenant are invisible and untouchable', async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    const bPlant = await seedPlant(B.tenantId);
    const ids = await withSystem(async (tx) => {
      const q = async (sql: string, p: unknown[]) => (await tx.query<{ id: string }>(sql, p)).rows[0]!.id;
      const invoiceId = await q(
        `INSERT INTO app.invoices (tenant_id, number, fy, kind, issue_date, due_date, taxable, total, balance, status, pdf_key)
         VALUES ($1, $2, '2026-27', 'manual', '2026-04-10', '2026-04-20', 100, 118, 118, 'issued', $3) RETURNING id`,
        [B.tenantId, `ISO/${uniq()}`, `t/${B.tenantId}/billing/x.pdf`]);
      const paymentId = await q(
        `INSERT INTO app.payments (tenant_id, mode, amount, payment_date, status, source) VALUES ($1, 'neft', 10, '2026-04-11', 'applied', 'manual') RETURNING id`,
        [B.tenantId]);
      const receiptId = await q(
        `INSERT INTO app.receipts (tenant_id, number, payment_id, receipt_date, pdf_key) VALUES ($1, $2, $3, '2026-04-11', $4) RETURNING id`,
        [B.tenantId, `ISO-R/${uniq()}`, paymentId, `t/${B.tenantId}/billing/r.pdf`]);
      const creditNoteId = await q(
        `INSERT INTO app.credit_notes (tenant_id, number, invoice_id, cn_date, taxable, total, reason, pdf_key)
         VALUES ($1, $2, $3, '2026-04-12', 10, 11.8, 'r', $4) RETURNING id`,
        [B.tenantId, `ISO-C/${uniq()}`, invoiceId, `t/${B.tenantId}/billing/c.pdf`]);
      return { invoiceId, receiptId, creditNoteId };
    });
    const billingSnap = () => withSystem(async (tx) => JSON.stringify((await tx.query(
      `SELECT (SELECT count(*) FROM app.payment_notifications WHERE tenant_id = $1) AS pn,
              (SELECT count(*) FROM app.tds_entries WHERE tenant_id = $1) AS tds,
              (SELECT count(*) FROM app.exports WHERE tenant_id = $1) AS exports,
              (SELECT rzp_link_id FROM app.invoices WHERE tenant_id = $1 LIMIT 1) AS link`, [B.tenantId])).rows));
    const { token } = await loginClient(A.admin.email);
    const before = await snapshot(B.tenantId);
    const beforeBilling = await billingSnap();
    for (const c of CASES_P3({ tenantId: B.tenantId, plantId: bPlant, ...ids })) {
      const res = await api()[c.method](`/api/v1${c.path}`).set(bearer(token)).send(c.body ?? {});
      expect(res.status, `${c.method} ${c.path} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404);
    }
    expect(await snapshot(B.tenantId)).toBe(before);
    expect(await billingSnap()).toBe(beforeBilling);
    const text = JSON.stringify([
      (await api().get('/api/v1/billing/invoices?pageSize=100').set(bearer(token))).body,
      (await api().get('/api/v1/billing/payments').set(bearer(token))).body,
      (await api().get('/api/v1/billing/summary').set(bearer(token))).body,
      (await api().get('/api/v1/billing/subscriptions').set(bearer(token))).body,
      (await api().get('/api/v1/banners').set(bearer(token))).body,
      (await api().get('/api/v1/company/exports').set(bearer(token))).body,
    ]);
    for (const id of [B.tenantId, bPlant, ids.invoiceId, ids.receiptId, ids.creditNoteId]) expect(text).not.toContain(id);
  });
});
