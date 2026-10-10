import { many } from '../../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../../db/tenant';
import { addDays, diffDays, financialYear, formatDisplayDate, todayIST } from '../../../lib/dates';
import { badRequest } from '../../../lib/errors';
import type { AdminReportKey } from '../../../shared/enums';
import { stateName } from '../../../shared/indian-states';
import { NUM0, NUM2, type ReportTable } from '../../reports/table';
import { usageRows } from '../usage/usage.routes';

export interface AdminReportQuery { from?: string; to?: string; clientId?: string; windowDays?: number }
type Row = Record<string, string | number | null>;
const sumCol = (rows: Row[], key: string) => Math.round(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) * 100) / 100;
const totalRow = (rows: Row[], label: string, keys: string[], first: string): Row =>
  ({ [first]: label, ...Object.fromEntries(keys.map((k) => [k, sumCol(rows, k)])) });

function range(q: AdminReportQuery) {
  const today = todayIST();
  const fy = financialYear(today);
  const from = q.from ?? `${fy.slice(0, 4)}-04-01`;
  const to = q.to ?? today;
  if (from > to) throw badRequest('INVALID_RANGE', '"from" must be on or before "to".');
  return { from, to, sub: `${formatDisplayDate(from)} to ${formatDisplayDate(to)}` };
}

export async function adminReport(ctx: AdminTxCtx, key: AdminReportKey, q: AdminReportQuery): Promise<ReportTable> {
  const c = q.clientId ?? null;
  return withAdmin(ctx, async (tx) => {
    switch (key) {
      case 'revenue': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT i.issue_date AS date, i.number, c.display_name AS client,
                  (SELECT string_agg(DISTINCT p.name, ', ') FROM app.invoice_lines l JOIN app.plants p ON p.tenant_id = l.tenant_id AND p.id = l.plant_id
                    WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id) AS plant,
                  (SELECT string_agg(DISTINCT s.plan_snapshot->>'name', ', ') FROM app.invoice_lines l
                     JOIN app.subscriptions s ON s.tenant_id = l.tenant_id AND s.id = l.subscription_id
                    WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id) AS plan,
                  i.taxable::float8 AS taxable, (i.cgst + i.sgst + i.igst)::float8 AS gst, i.total::float8 AS total, i.status
             FROM app.invoices i JOIN app.clients c ON c.id = i.tenant_id
            WHERE i.status <> 'draft' AND i.issue_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.tenant_id = $3)
            ORDER BY i.issue_date, i.number`, [r.from, r.to, c]);
        return { title: 'Revenue (billed)', subtitle: r.sub,
          columns: [{ key: 'date', header: 'Date' }, { key: 'number', header: 'Invoice' }, { key: 'client', header: 'Client', width: 28 },
            { key: 'plant', header: 'Plant', width: 24 }, { key: 'plan', header: 'Plan' }, { key: 'taxable', header: 'Taxable', numFmt: NUM2 },
            { key: 'gst', header: 'GST', numFmt: NUM2 }, { key: 'total', header: 'Total', numFmt: NUM2 }, { key: 'status', header: 'Status' }],
          rows, footer: [totalRow(rows, 'TOTAL', ['taxable', 'gst', 'total'], 'date')] };
      }
      case 'collections': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT p.payment_date AS date, c.display_name AS client, p.mode, p.reference, p.amount::float8 AS amount, p.status,
                  (SELECT number FROM app.receipts x WHERE x.tenant_id = p.tenant_id AND x.payment_id = p.id LIMIT 1) AS receipt
             FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id
            WHERE p.payment_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR p.tenant_id = $3) ORDER BY p.payment_date`, [r.from, r.to, c]);
        const applied = rows.filter((x) => x.status === 'applied');
        return { title: 'Collections', subtitle: r.sub,
          columns: [{ key: 'date', header: 'Date' }, { key: 'client', header: 'Client', width: 28 }, { key: 'mode', header: 'Mode' },
            { key: 'reference', header: 'Reference', width: 20 }, { key: 'amount', header: 'Amount', numFmt: NUM2 },
            { key: 'status', header: 'Status' }, { key: 'receipt', header: 'Receipt' }],
          rows, footer: [{ date: 'TOTAL (applied)', amount: sumCol(applied, 'amount') }] };
      }
      case 'ageing': {
        const today = todayIST();
        const inv = await many<{ client: string; number: string; due: string; balance: string }>(tx,
          `SELECT c.display_name AS client, i.number, i.due_date AS due, i.balance FROM app.invoices i JOIN app.clients c ON c.id = i.tenant_id
            WHERE i.status IN ('issued', 'partially_paid', 'overdue') AND i.balance > 0 AND ($1::uuid IS NULL OR i.tenant_id = $1)
            ORDER BY c.display_name, i.due_date`, [c]);
        const rows: Row[] = inv.map((i) => {
          const od = diffDays(i.due, today);
          const b = Number(i.balance);
          return { client: i.client, number: i.number, due: i.due, notDue: od <= 0 ? b : 0, d30: od > 0 && od <= 30 ? b : 0,
            d60: od > 30 && od <= 60 ? b : 0, d90: od > 60 && od <= 90 ? b : 0, d90p: od > 90 ? b : 0, total: b };
        });
        const k = ['notDue', 'd30', 'd60', 'd90', 'd90p', 'total'];
        return { title: 'Outstanding and ageing', subtitle: `As on ${formatDisplayDate(today)}`,
          columns: [{ key: 'client', header: 'Client', width: 28 }, { key: 'number', header: 'Invoice' }, { key: 'due', header: 'Due' },
            { key: 'notDue', header: 'Not due', numFmt: NUM2 }, { key: 'd30', header: '0–30', numFmt: NUM2 }, { key: 'd60', header: '31–60', numFmt: NUM2 },
            { key: 'd90', header: '61–90', numFmt: NUM2 }, { key: 'd90p', header: '90+', numFmt: NUM2 }, { key: 'total', header: 'Total', numFmt: NUM2 }],
          rows, footer: [totalRow(rows, 'TOTAL', k, 'client')] };
      }
      case 'gst-register': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT 'Invoice' AS type, i.number, i.issue_date AS date, (i.buyer_snapshot->>'gstin') AS gstin, (i.buyer_snapshot->>'legalName') AS name,
                  i.place_of_supply AS pos, i.taxable::float8 AS taxable, i.cgst::float8 AS cgst, i.sgst::float8 AS sgst, i.igst::float8 AS igst,
                  i.total::float8 AS total
             FROM app.invoices i WHERE i.status <> 'draft' AND i.issue_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.tenant_id = $3)
           UNION ALL
           SELECT 'Credit note', cn.number, cn.cn_date, (i.buyer_snapshot->>'gstin'), (i.buyer_snapshot->>'legalName'), i.place_of_supply,
                  -cn.taxable::float8, -cn.cgst::float8, -cn.sgst::float8, -cn.igst::float8, -cn.total::float8
             FROM app.credit_notes cn JOIN app.invoices i ON i.tenant_id = cn.tenant_id AND i.id = cn.invoice_id
            WHERE cn.cn_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR cn.tenant_id = $3)
           ORDER BY 3, 2`, [r.from, r.to, c]);
        return { title: 'GST sales register', subtitle: r.sub,
          columns: [{ key: 'type', header: 'Type' }, { key: 'number', header: 'Number' }, { key: 'date', header: 'Date' },
            { key: 'gstin', header: 'GSTIN', width: 18 }, { key: 'name', header: 'Name', width: 28 }, { key: 'pos', header: 'Place of supply', width: 20 },
            { key: 'taxable', header: 'Taxable', numFmt: NUM2 }, { key: 'cgst', header: 'CGST', numFmt: NUM2 }, { key: 'sgst', header: 'SGST', numFmt: NUM2 },
            { key: 'igst', header: 'IGST', numFmt: NUM2 }, { key: 'total', header: 'Total', numFmt: NUM2 }],
          rows, footer: [totalRow(rows, 'NET TOTAL', ['taxable', 'cgst', 'sgst', 'igst', 'total'], 'type')] };
      }
      case 'tds': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT t.deduction_date AS date, c.display_name AS client, i.number AS invoice, t.section, t.amount::float8 AS amount,
                  t.certificate_status AS certificate, CASE WHEN t.verified THEN 'yes' ELSE 'pending' END AS verified
             FROM app.tds_entries t JOIN app.clients c ON c.id = t.tenant_id JOIN app.invoices i ON i.tenant_id = t.tenant_id AND i.id = t.invoice_id
            WHERE t.deduction_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR t.tenant_id = $3) ORDER BY t.deduction_date`, [r.from, r.to, c]);
        for (const x of rows) {
          const d = String(x.date);
          const m = Number(d.slice(5, 7));
          x.quarter = `${financialYear(d)} Q${m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4}`;
        }
        return { title: 'TDS report', subtitle: r.sub,
          columns: [{ key: 'quarter', header: 'Quarter' }, { key: 'date', header: 'Date' }, { key: 'client', header: 'Client', width: 28 },
            { key: 'invoice', header: 'Invoice' }, { key: 'section', header: 'Section' }, { key: 'amount', header: 'Amount', numFmt: NUM2 },
            { key: 'certificate', header: 'Certificate' }, { key: 'verified', header: 'Verified' }],
          rows, footer: [{ quarter: 'TOTAL', amount: sumCol(rows, 'amount') }] };
      }
      case 'renewals': {
        const today = todayIST();
        const until = addDays(today, q.windowDays ?? 90);
        const rows = await many<Row>(tx,
          `SELECT 'Subscription' AS kind, c.display_name AS client, p.name AS plant, s.plan_snapshot->>'name' AS plan, s.end_date AS "endDate"
             FROM app.subscriptions s JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id JOIN app.clients c ON c.id = s.tenant_id
            WHERE s.status = 'active' AND s.end_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.tenant_id = $3)
           UNION ALL
           SELECT 'O&M contract', c.display_name, p.name, NULL, p.om_end
             FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
            WHERE p.setup_status <> 'closed' AND p.om_end BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR p.tenant_id = $3)
           ORDER BY 5`, [today, until, c]);
        for (const x of rows) x.daysLeft = diffDays(today, String(x.endDate));
        return { title: 'Renewals and expiries', subtitle: `${formatDisplayDate(today)} to ${formatDisplayDate(until)}`,
          columns: [{ key: 'kind', header: 'Type' }, { key: 'client', header: 'Client', width: 28 }, { key: 'plant', header: 'Plant', width: 24 },
            { key: 'plan', header: 'Plan' }, { key: 'endDate', header: 'Ends' }, { key: 'daysLeft', header: 'Days left', numFmt: NUM0 }], rows };
      }
      case 'contract-value': {
        const rows = await many<Row>(tx,
          `SELECT c.display_name AS client,
                  coalesce((SELECT sum(b.amount) FROM app.billing_schedule b JOIN app.subscriptions s ON s.tenant_id = b.tenant_id AND s.id = b.subscription_id
                             WHERE b.tenant_id = c.id), 0)::float8 AS contract,
                  (coalesce((SELECT sum(taxable) FROM app.invoices WHERE tenant_id = c.id AND status <> 'draft'), 0)
                    - coalesce((SELECT sum(taxable) FROM app.credit_notes WHERE tenant_id = c.id), 0))::float8 AS billed,
                  coalesce((SELECT sum(amount) FROM app.payments WHERE tenant_id = c.id AND status = 'applied'), 0)::float8 AS collected,
                  coalesce((SELECT sum(balance) FROM app.invoices WHERE tenant_id = c.id AND status IN ('issued', 'partially_paid', 'overdue')), 0)::float8 AS outstanding
             FROM app.clients c WHERE c.status <> 'deleted' AND ($1::uuid IS NULL OR c.id = $1) ORDER BY c.display_name`, [c]);
        for (const x of rows) x.remaining = Math.round((Number(x.contract) - Number(x.billed)) * 100) / 100;
        return { title: 'Contract value', subtitle: 'Contract, billed and remaining are excluding GST; collected and outstanding include GST',
          columns: [{ key: 'client', header: 'Client', width: 28 }, { key: 'contract', header: 'Contract value', numFmt: NUM2 },
            { key: 'billed', header: 'Billed', numFmt: NUM2 }, { key: 'remaining', header: 'Remaining to bill', numFmt: NUM2 },
            { key: 'collected', header: 'Collected', numFmt: NUM2 }, { key: 'outstanding', header: 'Outstanding', numFmt: NUM2 }],
          rows, footer: [totalRow(rows, 'TOTAL', ['contract', 'billed', 'remaining', 'collected', 'outstanding'], 'client')] };
      }
      case 'cheques': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT p.payment_date AS date, c.display_name AS client, p.reference AS cheque, p.bank, p.cheque_date AS "chequeDate",
                  p.amount::float8 AS amount, p.status, to_char(coalesce(p.cleared_at, p.bounced_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "statusDate",
                  p.bounce_reason AS reason
             FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id
            WHERE p.mode = 'cheque' AND p.payment_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR p.tenant_id = $3) ORDER BY p.payment_date`, [r.from, r.to, c]);
        return { title: 'Cheque register', subtitle: r.sub,
          columns: [{ key: 'date', header: 'Received' }, { key: 'client', header: 'Client', width: 28 }, { key: 'cheque', header: 'Cheque no.' },
            { key: 'bank', header: 'Bank' }, { key: 'chequeDate', header: 'Cheque date' }, { key: 'amount', header: 'Amount', numFmt: NUM2 },
            { key: 'status', header: 'Status' }, { key: 'statusDate', header: 'Cleared/bounced on' }, { key: 'reason', header: 'Bounce reason', width: 24 }], rows };
      }
      case 'clients': {
        const rows = await many<Row & { state_code: string }>(tx,
          `SELECT c.code, c.display_name AS name, c.state_code, (SELECT count(*) FROM app.plants p WHERE p.tenant_id = c.id) AS plants,
                  c.account_state AS state,
                  coalesce((SELECT sum(balance) FROM app.invoices i WHERE i.tenant_id = c.id AND i.status IN ('issued', 'partially_paid', 'overdue')), 0)::float8 AS outstanding,
                  (SELECT min(due_date) FROM app.invoices i WHERE i.tenant_id = c.id AND i.status IN ('issued', 'partially_paid', 'overdue')) AS "nextDue",
                  to_char(c.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS created
             FROM app.clients c WHERE c.status <> 'deleted' ORDER BY c.display_name`);
        return { title: 'Clients',
          columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Client', width: 28 }, { key: 'stateName', header: 'State' },
            { key: 'plants', header: 'Plants', numFmt: NUM0 }, { key: 'state', header: 'Account state' },
            { key: 'outstanding', header: 'Outstanding', numFmt: NUM2 }, { key: 'nextDue', header: 'Next due' }, { key: 'created', header: 'Created' }],
          rows: rows.map((x) => ({ ...x, stateName: stateName(x.state_code) })) };
      }
      case 'plants': {
        const rows = await many<Row>(tx,
          `SELECT c.display_name AS client, p.name AS plant, p.type, p.capacity_mld::float8 AS capacity,
                  (SELECT s.plan_snapshot->>'name' FROM app.subscriptions s WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id AND s.status IN ('active', 'scheduled')
                    ORDER BY (s.status = 'active') DESC LIMIT 1) AS plan,
                  (SELECT max(s.end_date) FROM app.subscriptions s WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id AND s.status IN ('active', 'scheduled')) AS "subEnd",
                  p.account_state AS state, p.setup_status AS setup,
                  (SELECT max(l.log_date) FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft') AS "lastLogsheet"
             FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
            WHERE c.status <> 'deleted' AND ($1::uuid IS NULL OR p.tenant_id = $1) ORDER BY c.display_name, p.name`, [c]);
        return { title: 'Plants',
          columns: [{ key: 'client', header: 'Client', width: 28 }, { key: 'plant', header: 'Plant', width: 24 }, { key: 'type', header: 'Type' },
            { key: 'capacity', header: 'MLD', numFmt: NUM2 }, { key: 'plan', header: 'Plan' }, { key: 'subEnd', header: 'Subscription end' },
            { key: 'state', header: 'Account state' }, { key: 'setup', header: 'Setup' }, { key: 'lastLogsheet', header: 'Last logsheet' }], rows };
      }
      case 'subscriptions': {
        const rows = await many<Row>(tx,
          `SELECT c.display_name AS client, p.name AS plant, s.plan_snapshot->>'name' AS plan, (s.plan_snapshot->>'termYears')::int AS term,
                  s.start_date AS start, s.end_date AS "end", s.billing_mode AS mode, s.status,
                  coalesce((SELECT sum(b.amount) FROM app.billing_schedule b WHERE b.tenant_id = s.tenant_id AND b.subscription_id = s.id), 0)::float8 AS value
             FROM app.subscriptions s JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id JOIN app.clients c ON c.id = s.tenant_id
            WHERE c.status <> 'deleted' AND ($1::uuid IS NULL OR s.tenant_id = $1) ORDER BY c.display_name, p.name, s.start_date`, [c]);
        return { title: 'Subscriptions',
          columns: [{ key: 'client', header: 'Client', width: 28 }, { key: 'plant', header: 'Plant', width: 24 }, { key: 'plan', header: 'Plan' },
            { key: 'term', header: 'Years', numFmt: NUM0 }, { key: 'start', header: 'Start' }, { key: 'end', header: 'End' },
            { key: 'mode', header: 'Billing' }, { key: 'status', header: 'Status' }, { key: 'value', header: 'Contract value (ex GST)', numFmt: NUM2 }],
          rows, footer: [totalRow(rows, 'TOTAL', ['value'], 'client')] };
      }
      case 'usage': {
        const u = await usageRows(ctx, q.clientId);
        return { title: 'Usage',
          columns: [{ key: 'clientName', header: 'Client', width: 28 }, { key: 'plantName', header: 'Plant', width: 24 },
            { key: 'activeUsers', header: 'Users', numFmt: NUM0 }, { key: 'maxUsers', header: 'Limit', numFmt: NUM0 },
            { key: 'storageGbUsed', header: 'Storage GB', numFmt: NUM2 }, { key: 'storageGb', header: 'Limit GB', numFmt: NUM0 },
            { key: 'logsheets7d', header: 'Logsheets 7d', numFmt: NUM0 }, { key: 'logsheets30d', header: 'Logsheets 30d', numFmt: NUM0 },
            { key: 'lastLogsheetDate', header: 'Last logsheet' }, { key: 'flags', header: 'Flags', width: 30 }],
          rows: u.map((x) => ({
            clientName: x.clientName, plantName: x.plantName, activeUsers: x.activeUsers, maxUsers: x.maxUsers,
            storageGbUsed: Math.round((x.storageBytes / 1073741824) * 100) / 100, storageGb: x.storageGb, logsheets7d: x.logsheets7d,
            logsheets30d: x.logsheets30d, lastLogsheetDate: x.lastLogsheetDate,
            flags: Object.entries(x.flags).filter(([, v]) => v).map(([k]) => k).join(', '),
          })) };
      }
      case 'lifecycle-history': {
        const r = range(q);
        const rows = await many<Row>(tx,
          `SELECT to_char(e.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at, c.display_name AS client, p.name AS plant,
                  e.from_state AS "from", e.to_state AS "to", e.cause, e.note, e.actor_type AS actor
             FROM app.lifecycle_events e JOIN app.clients c ON c.id = e.tenant_id LEFT JOIN app.plants p ON p.tenant_id = e.tenant_id AND p.id = e.plant_id
            WHERE (e.at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR e.tenant_id = $3) ORDER BY e.at`, [r.from, r.to, c]);
        return { title: 'Lifecycle history', subtitle: r.sub,
          columns: [{ key: 'at', header: 'When' }, { key: 'client', header: 'Client', width: 28 }, { key: 'plant', header: 'Plant', width: 24 },
            { key: 'from', header: 'From' }, { key: 'to', header: 'To' }, { key: 'cause', header: 'Cause' }, { key: 'note', header: 'Note', width: 30 },
            { key: 'actor', header: 'By' }], rows };
      }
      default:
        throw badRequest('UNKNOWN_REPORT', 'Unknown report.');
    }
  });
}
