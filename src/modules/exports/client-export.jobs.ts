import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver, { type Archiver } from 'archiver';
import ExcelJS from 'exceljs';
import { exec, many, maybeOne } from '../../db/sql';
import { withSystem, type Tx } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { minDate, todayIST } from '../../lib/dates';
import { systemActor, writeAudit } from '../audit/audit.service';
import { notifySuperAdmins } from '../billing/billing-notify';
import { docFileName, storage, tenantKey } from '../files/storage';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import { readStoredFile } from './download';
import { logsheetWorkbookBuffer } from './exports.jobs';

type Rows = Array<Record<string, unknown>>;

function appendAndWait(zip: Archiver, data: Buffer, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = () => { zip.off('error', onError); resolve(); };
    const onError = (err: Error) => { zip.off('entry', onEntry); reject(err); };
    zip.once('entry', onEntry);
    zip.once('error', onError);
    zip.append(data, { name });
  });
}

async function workbook(sheets: Record<string, Rows>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name.slice(0, 31));
    const cols = Object.keys(rows[0] ?? {});
    ws.addRow(cols).font = { bold: true };
    for (const r of rows) {
      ws.addRow(cols.map((c) => {
        const v = r[c];
        return v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
      }));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Every query below filters tenant_id (and plant_id): this job runs as admin_user. */
const q = (tx: Tx, sql: string, p: unknown[]) => many<Record<string, unknown>>(tx, sql, p);

registerHandler(QUEUES.exportClient, async (data) => {
  const { tenantId, exportId } = data as { tenantId: string; exportId: string };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ommis-export-'));
  const zipPath = path.join(dir, `${exportId}.zip`);
  try {
    const exp = await withSystem(async (tx) => {
      await exec(tx, `UPDATE app.exports SET status = 'building' WHERE tenant_id = $1 AND id = $2`, [tenantId, exportId]);
      return maybeOne<{ scope: { plantIds?: string[] | null }; created_by: string | null; requested_by_admin: string | null }>(
        tx, 'SELECT scope, created_by, requested_by_admin FROM app.exports WHERE tenant_id = $1 AND id = $2', [tenantId, exportId]);
    });
    if (!exp) return;
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 6 } });
    const finished = new Promise<void>((resolve, reject) => { out.on('close', () => resolve()); out.on('error', reject); zip.on('error', reject); });
    zip.pipe(out);

    const meta = await withSystem(async (tx) => ({
      users: await q(tx, `SELECT id, name, email, mobile, designation, is_client_admin, status, last_login_at, created_at FROM app.users WHERE tenant_id = $1 ORDER BY name`, [tenantId]),
      roles: await q(tx, `SELECT u.email, p.code AS plant, r.role FROM app.user_plant_roles r JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
                          JOIN app.plants p ON p.tenant_id = r.tenant_id AND p.id = r.plant_id WHERE r.tenant_id = $1`, [tenantId]),
      audit: await q(tx, `SELECT at, actor_type, actor_id, acting_as_admin_id, action, entity, entity_id, before, after, reason, ip
                          FROM app.audit_log WHERE tenant_id = $1 ORDER BY at DESC LIMIT 100000`, [tenantId]),
      invoices: await q(tx, `SELECT number, issue_date, due_date, kind, taxable, cgst, sgst, igst, round_off, total, paid, tds, credit_noted,
                             credit_applied, balance, status, pdf_key FROM app.invoices WHERE tenant_id = $1 AND status <> 'draft' ORDER BY issue_date`, [tenantId]),
      creditNotes: await q(tx, `SELECT number, cn_date, taxable, cgst, sgst, igst, total, reason, pdf_key FROM app.credit_notes WHERE tenant_id = $1 ORDER BY cn_date`, [tenantId]),
      payments: await q(tx, `SELECT payment_date, mode, amount, reference, bank, status, source FROM app.payments WHERE tenant_id = $1 ORDER BY payment_date`, [tenantId]),
      receipts: await q(tx, `SELECT number, receipt_date, pdf_key FROM app.receipts WHERE tenant_id = $1 ORDER BY receipt_date`, [tenantId]),
      tds: await q(tx, `SELECT t.deduction_date, i.number AS invoice, t.amount, t.section, t.certificate_status, t.verified FROM app.tds_entries t
                        JOIN app.invoices i ON i.tenant_id = t.tenant_id AND i.id = t.invoice_id WHERE t.tenant_id = $1`, [tenantId]),
      credit: await q(tx, `SELECT entry_date, kind, amount, ref_type FROM app.client_credit_ledger WHERE tenant_id = $1 ORDER BY entry_date`, [tenantId]),
      plants: await many<{ id: string; code: string; mis_start: string; om_end: string }>(tx,
        `SELECT id, code, mis_start, om_end FROM app.plants WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY code`,
        [tenantId, exp.scope.plantIds ?? null]),
    }));
    await appendAndWait(zip, await workbook({ Users: meta.users, 'Plant roles': meta.roles }), 'company/users.xlsx');
    await appendAndWait(zip, await workbook({ 'Audit log': meta.audit }), 'company/audit-log.xlsx');
    const strip = (rows: Rows) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'pdf_key')));
    await appendAndWait(zip, await workbook({
      Invoices: strip(meta.invoices), 'Credit notes': strip(meta.creditNotes), Payments: meta.payments, Receipts: strip(meta.receipts),
      TDS: meta.tds, 'Credit ledger': meta.credit,
    }), 'billing/billing.xlsx');
    for (const doc of [...meta.invoices, ...meta.creditNotes, ...meta.receipts]) {
      if (typeof doc.pdf_key === 'string') {
        await appendAndWait(zip, await readStoredFile(doc.pdf_key), `billing/${docFileName(String(doc.number))}.pdf`);
      }
    }
    const today = todayIST();
    for (const p of meta.plants) {
      const to = minDate(today, p.om_end);
      if (p.mis_start <= to) {
        try {
          await appendAndWait(zip, await logsheetWorkbookBuffer(tenantId, p.id, p.mis_start, to), `plants/${p.code}/logsheets.xlsx`);
        } catch (err) {
          // e.g. a plant whose settings were never completed: the export still succeeds, with a note instead of the workbook
          await appendAndWait(zip, Buffer.from(`Logsheet data could not be exported: ${String((err as Error).message)}\n`), `plants/${p.code}/logsheets-unavailable.txt`);
        }
      }
      const s = await withSystem(async (tx) => {
        const args = [tenantId, p.id];
        return {
          Parameters: await q(tx, `SELECT code, name, group_key, unit, input_mode, formula, decimals, hard_min, hard_max, aggregation, std_type, direction,
                                   event_rule, mandatory, active_from, active_to FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 ORDER BY code`, args),
          Standards: await q(tx, `SELECT pr.code, s.effective_from, s.std_value, s.monthly_allowance, s.limit_min, s.limit_max, s.reason
                                  FROM app.parameter_standards s JOIN app.parameters pr ON pr.tenant_id = s.tenant_id AND pr.id = s.parameter_id
                                 WHERE s.tenant_id = $1 AND pr.plant_id = $2 ORDER BY pr.code, s.effective_from`, args),
          Constants: await q(tx, `SELECT code, name, value, unit, effective_from, reason FROM app.plant_constants WHERE tenant_id = $1 AND plant_id = $2`, args),
          Stock: await q(tx, `SELECT name, unit, opening_balance, opening_date, min_level, is_active FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2`, args),
          Staff: await q(tx, `SELECT c.name, s.effective_from, s.strength FROM app.staff_categories c
                              LEFT JOIN app.staff_strengths s ON s.tenant_id = c.tenant_id AND s.category_id = c.id WHERE c.tenant_id = $1 AND c.plant_id = $2`, args),
          Safety: await q(tx, `SELECT i.name, r.effective_from, r.qty FROM app.safety_items i
                               LEFT JOIN app.safety_requirements r ON r.tenant_id = i.tenant_id AND r.item_id = i.id WHERE i.tenant_id = $1 AND i.plant_id = $2`, args),
          'Contract years': await q(tx, `SELECT year_no, start_date, end_date, days, fixed_fee FROM app.contract_years WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no`, args),
          Revenue: await q(tx, `SELECT y.year_no, r.name, pr.code AS parameter, r.rate, r.std_qty_per_day FROM app.revenue_components r
                                JOIN app.contract_years y ON y.tenant_id = r.tenant_id AND y.id = r.contract_year_id
                                JOIN app.parameters pr ON pr.tenant_id = r.tenant_id AND pr.id = r.parameter_id WHERE r.tenant_id = $1 AND y.plant_id = $2`, args),
          'Bank guarantees': await q(tx, `SELECT label, bg_number, bank, start_date, end_date, amount, claim_months, remarks FROM app.bank_guarantees WHERE tenant_id = $1 AND plant_id = $2`, args),
          Insurance: await q(tx, `SELECT policy_type, policy_number, insurer, start_date, end_date, sum_assured, premium, remarks FROM app.insurance_policies WHERE tenant_id = $1 AND plant_id = $2`, args),
        };
      });
      await appendAndWait(zip, await workbook(s), `plants/${p.code}/settings.xlsx`);
      const pdfs = await withSystem((tx) => many<{ file_key: string }>(tx,
        `SELECT file_key FROM app.pdf_documents WHERE tenant_id = $1 AND plant_id = $2 AND status IN ('current', 'stale') AND file_key IS NOT NULL ORDER BY d, doc_type`,
        [tenantId, p.id]));
      for (const f of pdfs) {
        const rel = f.file_key.split('/pdf/')[1] ?? f.file_key.split('/').pop() ?? 'file.pdf';
        await appendAndWait(zip, await readStoredFile(f.file_key), `plants/${p.code}/pdfs/${rel}`);
      }
    }
    await zip.finalize();
    await finished;
    const key = tenantKey(tenantId, 'exports', `${exportId}.zip`);
    await storage.putFile(key, zipPath, 'application/zip');
    const outbox = await withSystem(async (tx) => {
      await exec(tx, `UPDATE app.exports SET status = 'ready', file_key = $3, expires_at = now() + interval '7 days' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, exportId, key]);
      await writeAudit(tx, systemActor(tenantId), { action: 'export.client_ready', entity: 'export', entityId: exportId });
      const ob: Array<string | null> = [];
      if (exp.created_by) {
        const to = (await plantRecipients(tx, tenantId, null, ['client_admin'])).filter((u) => u.id === exp.created_by);
        ob.push(...await notify(tx, { tenantId, to, code: 'N-O08', title: 'Your data export is ready', body: 'Download within 7 days.',
          link: `/exports/${exportId}`, email: true, critical: true }));
      }
      if (exp.requested_by_admin) {
        ob.push(...await notifySuperAdmins(tx, { code: 'EXPORT_READY', title: 'Client data export ready', body: `Export ${exportId}`,
          link: `/clients/${tenantId}/exports`, clientId: tenantId, dedupeKey: `EXPORT_READY:${exportId}` }));
      }
      return ob;
    });
    sendInBackground(outbox);
  } catch (err) {
    await withSystem((tx) => exec(tx, `UPDATE app.exports SET status = 'failed', error = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, exportId, String((err as Error).message).slice(0, 300)]));
    throw err;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
