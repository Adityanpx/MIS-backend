import { exec, many, maybeOne, one } from '../../db/sql';
import { withAdmin, withSystem, type AdminTxCtx, type Tx } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays, formatDisplayDate, maxDate, todayIST, type ISODate } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { D, Decimal, money, round2 } from '../../lib/money';
import type { RequestMeta } from '../../lib/request-meta';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { formatMoney } from '../../shared/format';
import { stateName } from '../../shared/indian-states';
import { adminActor, systemActor, writeAudit, type AuditActor } from '../audit/audit.service';
import { gstSplit } from '../domain/pricing';
import { evaluateTenant } from '../lifecycle/lifecycle.service';
import { sendInBackground } from '../notifications/email.service';
import { loadBillingConfig, lockTenantBilling, sellerReady, type BillingConfig } from './billing-config';
import { notifyClientBilling, notifySuperAdmins } from './billing-notify';
import { applyCreditToInvoice } from './credit';
import { invoiceDetail, tenantOfInvoice } from './invoice-queries';
import { recomputeInvoice } from './invoice-totals';
import { nextDocNumber } from './numbering';

export interface LineInput {
  description: string; sac: string; qty: string | number; rate: string;
  plantId?: string | null; subscriptionId?: string | null; billingYear?: number | null;
}

/** INV-03/04: taxable = Σ round2(qty × rate); each tax round2; grand total rounded to the rupee with a round-off line. */
export function invoiceMath(lines: Array<{ qty: string | number; rate: string }>, ratePct: number, intra: boolean | null) {
  const taxable = lines.reduce((s, l) => s.plus(round2(D(l.qty).mul(l.rate))), D(0));
  const g = gstSplit(money(taxable), ratePct, intra);
  const exact = D(g.total);
  const rounded = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return {
    taxable: g.taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, roundOff: money(rounded.minus(exact)), total: money(rounded),
    gstType: intra === null ? null : intra ? 'intra' : 'inter',
  };
}

async function insertDraft(
  tx: Tx, tenantId: string, kind: 'subscription' | 'manual', lines: LineInput[], dueDate: ISODate | null,
  notes: string | null, createdBy: string | null, cfg: BillingConfig,
): Promise<string> {
  const client = await one<{ state_code: string }>(tx, 'SELECT state_code FROM app.clients WHERE id = $1', [tenantId]);
  const intra = cfg.seller.stateCode ? cfg.seller.stateCode === client.state_code : null;
  const m = invoiceMath(lines, cfg.tax.gstRatePct, intra);
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.invoices (tenant_id, kind, due_date, gst_type, gst_rate_pct, taxable, cgst, sgst, igst, round_off, total,
                               balance, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'draft', $12, $13) RETURNING id`,
    [tenantId, kind, dueDate, m.gstType, cfg.tax.gstRatePct, m.taxable, m.cgst, m.sgst, m.igst, m.roundOff, m.total, notes, createdBy],
  );
  for (const l of lines) {
    await exec(
      tx,
      `INSERT INTO app.invoice_lines (tenant_id, invoice_id, plant_id, subscription_id, billing_year, description, sac, qty, rate, taxable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, id, l.plantId ?? null, l.subscriptionId ?? null, l.billingYear ?? null, l.description, l.sac, l.qty, l.rate,
        money(round2(D(l.qty).mul(l.rate)))],
    );
  }
  return id;
}

/**
 * INV-02/05/06: assigns the number, freezes seller/buyer snapshots and GST at issue time, applies credit (CRD-02).
 * Call inside a transaction AFTER lockTenantBilling(tx, tenantId).
 */
export async function issueInvoice(
  tx: Tx, tenantId: string, invoiceId: string, cfg: BillingConfig, actor: AuditActor, today: ISODate, meta?: RequestMeta,
) {
  const inv = await maybeOne<{ status: string; due_date: string | null }>(
    tx, 'SELECT status, due_date FROM app.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, invoiceId]);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw conflict('INVOICE_NOT_EDITABLE', 'Only a draft invoice can be issued.');
  if (!sellerReady(cfg.seller)) {
    throw unprocessable('SELLER_NOT_CONFIGURED', 'Fill Settings → Company (legal name, state and GSTIN) before issuing invoices.');
  }
  const c = await one<{
    legal_name: string; display_name: string; gstin: string | null; pan: string | null; state_code: string;
    address: Record<string, unknown>; billing_emails: string[];
  }>(tx, 'SELECT legal_name, display_name, gstin, pan, state_code, address, billing_emails FROM app.clients WHERE id = $1', [tenantId]);
  const lines = await many<{ qty: string; rate: string }>(
    tx, 'SELECT qty, rate FROM app.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2', [tenantId, invoiceId]);
  const intra = cfg.seller.stateCode === c.state_code;
  const m = invoiceMath(lines, cfg.tax.gstRatePct, intra);
  const minDue = addDays(today, cfg.billing.minPaymentTermsDays);
  const due = inv.due_date ? maxDate(inv.due_date, minDue) : minDue;
  const { number, fy } = await nextDocNumber(tx, 'invoice', today, cfg.numbering);
  const seller = { ...cfg.seller, sac: cfg.tax.sac, platformName: cfg.platformName };
  const buyer = {
    legalName: c.legal_name, displayName: c.display_name, gstin: c.gstin, pan: c.pan, stateCode: c.state_code,
    stateName: stateName(c.state_code), address: c.address, emails: c.billing_emails,
  };
  await exec(
    tx,
    `UPDATE app.invoices SET number = $3, fy = $4, issue_date = $5, due_date = $6, place_of_supply = $7, gst_type = $8,
            gst_rate_pct = $9, taxable = $10, cgst = $11, sgst = $12, igst = $13, round_off = $14, total = $15, balance = $15,
            status = 'issued', seller_snapshot = $16::jsonb, buyer_snapshot = $17::jsonb, issued_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId, number, fy, today, due, `${stateName(c.state_code)} (${c.state_code})`, m.gstType, cfg.tax.gstRatePct,
      m.taxable, m.cgst, m.sgst, m.igst, m.roundOff, m.total, JSON.stringify(seller), JSON.stringify(buyer)],
  );
  await writeAudit(tx, actor, { action: 'invoice.issue', entity: 'invoice', entityId: invoiceId, after: { number, total: m.total, dueDate: due } }, meta);
  if (cfg.billing.autoApplyCredit) {
    await applyCreditToInvoice(tx, tenantId, invoiceId, { tolerance: cfg.tax.closeTolerance, today, actor });
  }
  await recomputeInvoice(tx, tenantId, invoiceId, { tolerance: cfg.tax.closeTolerance, today, actor });
  return { number, total: m.total, dueDate: due };
}

/** After an invoice was issued (after commit): payment link → PDF → N-B01 email (chained jobs). */
export async function afterIssue(tenantId: string, invoiceIds: string[]): Promise<void> {
  for (const invoiceId of invoiceIds) await enqueue(QUEUES.razorpayLinkCreate, { tenantId, invoiceId, then: 'pdf+notify' });
}

// ------------------------------------------------------------------ generation from the billing schedule (INV-01)
async function draftFromSchedule(tx: Tx, tenantId: string, scheduleId: string, cfg: BillingConfig, actor: AuditActor): Promise<string | null> {
  const r = await maybeOne<{
    subscription_id: string; year_no: number; period_from: string; period_to: string; amount: string; due_date: string;
    invoice_id: string | null; billing_mode: string; plant_id: string; plant_name: string; term_years: number;
  }>(
    tx,
    `SELECT b.subscription_id, b.year_no, b.period_from, b.period_to, b.amount, b.due_date, b.invoice_id,
            s.billing_mode, s.plant_id, p.name AS plant_name, (s.plan_snapshot->>'termYears')::int AS term_years
       FROM app.billing_schedule b
       JOIN app.subscriptions s ON s.tenant_id = b.tenant_id AND s.id = b.subscription_id
       JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id
      WHERE b.tenant_id = $1 AND b.id = $2
      FOR UPDATE OF b`,
    [tenantId, scheduleId],
  );
  if (!r || r.invoice_id) return null; // already invoiced by a parallel run
  const period = `${formatDisplayDate(r.period_from)} to ${formatDisplayDate(r.period_to)}`;
  const description = r.billing_mode === 'upfront' && r.year_no === 1
    ? `O&M MIS Platform subscription – Plant: ${r.plant_name} – Full term ${r.term_years} years, paid upfront (${period})`
    : `O&M MIS Platform subscription – Plant: ${r.plant_name} – Billing Year ${r.year_no} (${period})`;
  const id = await insertDraft(tx, tenantId, 'subscription', [{
    description, sac: cfg.tax.sac, qty: 1, rate: r.amount, plantId: r.plant_id, subscriptionId: r.subscription_id, billingYear: r.year_no,
  }], r.due_date, null, actor.actorId, cfg);
  await exec(tx, 'UPDATE app.billing_schedule SET invoice_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, scheduleId, id]);
  await writeAudit(tx, actor, { action: 'invoice.create_from_schedule', entity: 'invoice', entityId: id, after: { scheduleId, yearNo: r.year_no } });
  return id;
}

/**
 * invoices.generate (00:30 IST, also right after a plant/renewal is created): schedule rows with
 * planned_invoice_date <= today and no invoice. One transaction per row; a failing row never blocks the others.
 */
export async function generateDueInvoices(filter: { tenantId?: string; subscriptionId?: string } = {}) {
  const today = todayIST();
  const rows = await withSystem((tx) => many<{ id: string; tenant_id: string }>(
    tx,
    `SELECT b.id, b.tenant_id
       FROM app.billing_schedule b
       JOIN app.subscriptions s ON s.tenant_id = b.tenant_id AND s.id = b.subscription_id
       JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id
       JOIN app.clients c ON c.id = b.tenant_id
      WHERE b.invoice_id IS NULL AND b.planned_invoice_date <= $1
        AND s.status IN ('active', 'scheduled') AND p.account_state <> 'terminated' AND p.setup_status <> 'closed'
        AND c.status = 'active'
        AND ($2::uuid IS NULL OR b.tenant_id = $2) AND ($3::uuid IS NULL OR b.subscription_id = $3)
      ORDER BY b.planned_invoice_date, b.year_no
      LIMIT 500`,
    [today, filter.tenantId ?? null, filter.subscriptionId ?? null],
  ));
  const issued: Array<{ tenantId: string; invoiceId: string }> = [];
  let drafts = 0;
  let sellerMissing = false;
  for (const row of rows) {
    try {
      const r = await withSystem(async (tx) => {
        await lockTenantBilling(tx, row.tenant_id);
        const cfg = await loadBillingConfig(tx);
        const actor = systemActor(row.tenant_id);
        const id = await draftFromSchedule(tx, row.tenant_id, row.id, cfg, actor);
        if (!id) return null;
        if (cfg.billing.autoIssue && sellerReady(cfg.seller)) {
          await issueInvoice(tx, row.tenant_id, id, cfg, actor, today);
          return { id, issued: true, sellerMissing: false };
        }
        return { id, issued: false, sellerMissing: !sellerReady(cfg.seller) };
      });
      if (!r) continue;
      if (r.issued) issued.push({ tenantId: row.tenant_id, invoiceId: r.id });
      else drafts += 1;
      sellerMissing ||= r.sellerMissing;
    } catch (err) {
      logger.error({ err, scheduleId: row.id }, 'Invoice generation failed for schedule row');
      const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
        code: 'N-S06', title: 'Invoice generation failed', body: `Schedule row ${row.id}: ${String((err as Error).message).slice(0, 200)}`,
        clientId: row.tenant_id, dedupeKey: `N-S06:invgen:${row.id}:${today}`, email: true,
      })).catch(() => []);
      sendInBackground(outbox);
    }
  }
  if (sellerMissing) {
    const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S06', title: 'Invoices left as drafts: seller details missing',
      body: 'Fill Settings → Company (legal name, state, GSTIN), then issue the draft invoices.', link: '/settings/company',
      dedupeKey: `N-S06:seller:${today}`, email: true,
    }));
    sendInBackground(outbox);
  }
  for (const i of issued) await afterIssue(i.tenantId, [i.invoiceId]);
  return { created: issued.length + drafts, issued: issued.length, drafts };
}

// ------------------------------------------------------------------ Super Admin actions
export async function issueDraft(ctx: AdminTxCtx, invoiceId: string, meta: RequestMeta) {
  const tenantId = await withAdmin(ctx, (tx) => tenantOfInvoice(tx, invoiceId));
  await withAdmin(ctx, async (tx) => {
    await lockTenantBilling(tx, tenantId);
    const cfg = await loadBillingConfig(tx);
    await issueInvoice(tx, tenantId, invoiceId, cfg, adminActor(ctx.adminId, tenantId), todayIST(), meta);
  });
  await afterIssue(tenantId, [invoiceId]);
  return withAdmin(ctx, (tx) => invoiceDetail(tx, tenantId, invoiceId, { includeDrafts: true }));
}

export interface ManualInvoiceInput {
  clientId: string; plantId?: string; dueDate?: string; issueNow: boolean; notes?: string;
  lines: Array<{ description: string; sac?: string; qty: number; rate: string }>;
}
/** INV-09: one-off invoice (training, migration, bounce charges …). */
export async function createManualInvoice(ctx: AdminTxCtx, input: ManualInvoiceInput, meta: RequestMeta) {
  const today = todayIST();
  const { id, issued } = await withAdmin(ctx, async (tx) => {
    const c = await maybeOne<{ status: string }>(tx, `SELECT status FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [input.clientId]);
    if (!c) throw notFound('Client');
    if (input.plantId) {
      const p = await maybeOne(tx, 'SELECT 1 FROM app.plants WHERE tenant_id = $1 AND id = $2', [input.clientId, input.plantId]);
      if (!p) throw notFound('Plant');
    }
    if (input.dueDate && input.dueDate < today) throw unprocessable('DUE_DATE_IN_PAST', 'The due date cannot be in the past.');
    await lockTenantBilling(tx, input.clientId);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, input.clientId);
    const newId = await insertDraft(tx, input.clientId, 'manual', input.lines.map((l) => ({
      description: l.description, sac: l.sac ?? cfg.tax.sac, qty: l.qty, rate: l.rate, plantId: input.plantId ?? null,
    })), input.dueDate ?? null, input.notes ?? null, ctx.adminId, cfg);
    await writeAudit(tx, actor, { action: 'invoice.create_manual', entity: 'invoice', entityId: newId, after: input }, meta);
    if (input.issueNow) await issueInvoice(tx, input.clientId, newId, cfg, actor, today, meta);
    return { id: newId, issued: input.issueNow };
  });
  if (issued) await afterIssue(input.clientId, [id]);
  return withAdmin(ctx, (tx) => invoiceDetail(tx, input.clientId, id, { includeDrafts: true }));
}

// ------------------------------------------------------------------ credit notes (INV-12) and cancellation (INV-08)
async function insertCreditNote(
  tx: Tx, tenantId: string, invoiceId: string, amount: string, reason: string, cfg: BillingConfig, actor: AuditActor, today: ISODate, meta?: RequestMeta,
) {
  const inv = await one<{
    status: string; number: string | null; taxable: string; cgst: string; sgst: string; igst: string; total: string;
    gst_type: string | null; gst_rate_pct: string;
  }>(tx, `SELECT status, number, taxable, cgst, sgst, igst, total, gst_type, gst_rate_pct FROM app.invoices
           WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, invoiceId]);
  if (['draft', 'cancelled'].includes(inv.status)) throw conflict('INVOICE_NOT_CREDITABLE', 'Credit notes can only be raised on issued invoices.');
  const prior = await one<{ taxable: string; cgst: string; sgst: string; igst: string; total: string }>(
    tx,
    `SELECT coalesce(sum(taxable), 0) AS taxable, coalesce(sum(cgst), 0) AS cgst, coalesce(sum(sgst), 0) AS sgst,
            coalesce(sum(igst), 0) AS igst, coalesce(sum(total), 0) AS total
       FROM app.credit_notes WHERE tenant_id = $1 AND invoice_id = $2`,
    [tenantId, invoiceId],
  );
  const remaining = D(inv.taxable).minus(prior.taxable);
  if (D(amount).gt(remaining)) {
    throw unprocessable('CREDIT_NOTE_EXCEEDS', `At most ${money(remaining)} (taxable value) can still be credited on this invoice.`);
  }
  const closes = D(amount).eq(remaining);
  const g = gstSplit(money(amount), Number(inv.gst_rate_pct), inv.gst_type === 'intra');
  // The last credit note closes the invoice exactly (including the round-off line).
  const tax = closes
    ? { cgst: money(D(inv.cgst).minus(prior.cgst)), sgst: money(D(inv.sgst).minus(prior.sgst)), igst: money(D(inv.igst).minus(prior.igst)),
        total: money(D(inv.total).minus(prior.total)) }
    : { cgst: g.cgst, sgst: g.sgst, igst: g.igst, total: g.total };
  const { number } = await nextDocNumber(tx, 'credit_note', today, cfg.numbering);
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.credit_notes (tenant_id, number, invoice_id, cn_date, taxable, cgst, sgst, igst, total, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [tenantId, number, invoiceId, today, money(amount), tax.cgst, tax.sgst, tax.igst, tax.total, reason, actor.actorId],
  );
  await writeAudit(tx, actor, { action: 'credit_note.create', entity: 'credit_note', entityId: id, after: { number, invoiceId, total: tax.total }, reason }, meta);
  const outbox = await notifyClientBilling(tx, {
    tenantId, code: 'N-B11', title: `Credit note ${number}`, body: `${formatMoney(tax.total)} against invoice ${inv.number}.`,
    vars: { cnNo: number, amount: formatMoney(tax.total), invoiceNo: inv.number ?? '', reason },
  });
  return { id, number, total: tax.total, outbox };
}

export async function createCreditNote(ctx: AdminTxCtx, invoiceId: string, input: { amount: string; reason: string }, meta: RequestMeta) {
  const today = todayIST();
  const tenantId = await withAdmin(ctx, (tx) => tenantOfInvoice(tx, invoiceId));
  const r = await withAdmin(ctx, async (tx) => {
    await lockTenantBilling(tx, tenantId);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, tenantId);
    const cn = await insertCreditNote(tx, tenantId, invoiceId, input.amount, input.reason, cfg, actor, today, meta);
    await recomputeInvoice(tx, tenantId, invoiceId, { tolerance: cfg.tax.closeTolerance, today, actor, overflowKind: 'credit_note' });
    const ev = await evaluateTenant(tx, tenantId, { actor, cause: 'payment', note: `Credit note ${cn.number}` });
    return { cn, outbox: [...cn.outbox, ...ev.outbox] };
  });
  invalidateClientAuthCache();
  sendInBackground(r.outbox);
  await enqueue(QUEUES.pdfInvoice, { tenantId, kind: 'credit_note', id: r.cn.id });
  await enqueue(QUEUES.razorpayLinkCreate, { tenantId, invoiceId, then: 'pdf' }); // balance changed → new link amount
  return { id: r.cn.id, number: r.cn.number, total: r.cn.total };
}

/** INV-08/E19: a draft is simply cancelled; an issued invoice gets a credit note for the remaining value. */
export async function cancelInvoice(ctx: AdminTxCtx, invoiceId: string, input: { reason: string; releaseSchedule: boolean }, meta: RequestMeta) {
  const today = todayIST();
  const tenantId = await withAdmin(ctx, (tx) => tenantOfInvoice(tx, invoiceId));
  const r = await withAdmin(ctx, async (tx) => cancelInvoiceTx(tx, tenantId, invoiceId, input, adminActor(ctx.adminId, tenantId), today, meta));
  invalidateClientAuthCache();
  sendInBackground(r.outbox);
  if (r.creditNoteId) await enqueue(QUEUES.pdfInvoice, { tenantId, kind: 'credit_note', id: r.creditNoteId });
  if (input.releaseSchedule) await enqueue(QUEUES.invoicesGenerate, { tenantId });
  return withAdmin(ctx, (tx) => invoiceDetail(tx, tenantId, invoiceId, { includeDrafts: true }));
}

/** Transaction body, reused by subscription cancellation (SUB-07). */
export async function cancelInvoiceTx(
  tx: Tx, tenantId: string, invoiceId: string, input: { reason: string; releaseSchedule: boolean }, actor: AuditActor,
  today: ISODate, meta?: RequestMeta,
): Promise<{ creditNoteId: string | null; outbox: Array<string | null> }> {
  await lockTenantBilling(tx, tenantId);
  const cfg = await loadBillingConfig(tx);
  const inv = await one<{ status: string; taxable: string; number: string | null; rzp_link_id: string | null }>(
    tx, 'SELECT status, taxable, number, rzp_link_id FROM app.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, invoiceId]);
  if (inv.status === 'cancelled') throw conflict('INVOICE_ALREADY_CANCELLED', 'This invoice is already cancelled.');
  const outbox: Array<string | null> = [];
  let creditNoteId: string | null = null;
  if (inv.status !== 'draft') {
    const prior = await one<{ taxable: string }>(
      tx, 'SELECT coalesce(sum(taxable), 0) AS taxable FROM app.credit_notes WHERE tenant_id = $1 AND invoice_id = $2', [tenantId, invoiceId]);
    const remaining = D(inv.taxable).minus(prior.taxable);
    if (remaining.gt(0)) {
      const cn = await insertCreditNote(tx, tenantId, invoiceId, money(remaining), `Cancellation: ${input.reason}`, cfg, actor, today);
      creditNoteId = cn.id;
      outbox.push(...cn.outbox);
    }
  }
  await exec(
    tx,
    `UPDATE app.invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3 WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId, input.reason],
  );
  await recomputeInvoice(tx, tenantId, invoiceId, { tolerance: cfg.tax.closeTolerance, today, actor, overflowKind: 'credit_note' });
  if (input.releaseSchedule) {
    await exec(tx, 'UPDATE app.billing_schedule SET invoice_id = NULL WHERE tenant_id = $1 AND invoice_id = $2', [tenantId, invoiceId]);
  }
  await writeAudit(tx, actor, { action: 'invoice.cancel', entity: 'invoice', entityId: invoiceId, after: { number: inv.number, creditNoteId }, reason: input.reason }, meta);
  const ev = await evaluateTenant(tx, tenantId, { actor, cause: 'payment', note: `Invoice ${inv.number ?? 'draft'} cancelled` });
  outbox.push(...ev.outbox);
  return { creditNoteId, outbox };
}
