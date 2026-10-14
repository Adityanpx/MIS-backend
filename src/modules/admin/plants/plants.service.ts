import { exec, many, maybeOne, one, setClause } from '../../../db/sql';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import type { PlanSnapshot } from '../../../db/types';
import { todayIST } from '../../../lib/dates';
import { conflict, notFound, unprocessable } from '../../../lib/errors';
import { orderBy } from '../../../lib/pagination';
import type { RequestMeta } from '../../../lib/request-meta';
import type { BillingMode } from '../../../shared/enums';
import { adminActor, diff, writeAudit } from '../../audit/audit.service';
import { buildContractYears, omEndDate } from '../../domain/contract-years';
import { buildBillingSchedule, gstSplit, subscriptionEndDate, sumAmounts } from '../../domain/pricing';
import { applyTemplate } from '../../settings/apply-template';
import { getSetting } from '../../platform/settings.service';
import { gstRatePct, loadPlan } from '../plans/plans.service';
import { currentSubscription } from '../subscriptions/subscriptions.service';

export interface PlantCreateInput {
  clientId: string; name: string; code?: string; type: string; capacityMld: number; city?: string; stateCode: string;
  omStart: string; omTenureMonths: number; misStart?: string;
  subscription: { planId: string; startDate: string; billingMode: BillingMode; customPricePerYear?: string; customReason?: string };
}
interface PlantRowFull {
  id: string; tenant_id: string; code: string; name: string; type: string; capacity_mld: string; city: string | null;
  state_code: string; om_start: string; om_tenure_months: number; om_end: string; mis_start: string; setup_status: string;
  account_state: string; manual_suspended: boolean; hold_until: string | null; closed_at: string | null; created_at: string;
  client_name: string; client_code: string;
}
const PLANT_COLS = `
  p.id, p.tenant_id, p.code, p.name, p.type, p.capacity_mld, p.city, p.state_code, p.om_start, p.om_tenure_months,
  p.om_end, p.mis_start, p.setup_status, p.account_state, p.manual_suspended, p.hold_until, p.closed_at, p.created_at,
  c.display_name AS client_name, c.code AS client_code`;
const PLANT_FROM = 'FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id';
const SELECT = `SELECT ${PLANT_COLS} ${PLANT_FROM}`;

export const toPlantDto = (r: PlantRowFull) => ({
  id: r.id, clientId: r.tenant_id, clientName: r.client_name, clientCode: r.client_code, code: r.code, name: r.name,
  type: r.type, capacityMld: Number(r.capacity_mld), city: r.city, stateCode: r.state_code, omStart: r.om_start,
  omTenureMonths: r.om_tenure_months, omEnd: r.om_end, misStart: r.mis_start, setupStatus: r.setup_status,
  accountState: r.account_state, manualSuspended: r.manual_suspended, holdUntil: r.hold_until, closedAt: r.closed_at,
  createdAt: r.created_at,
});

async function loadPlant(tx: Tx, id: string, forUpdate = false): Promise<PlantRowFull> {
  if (forUpdate) await tx.query('SELECT 1 FROM app.plants WHERE id = $1 FOR UPDATE', [id]);
  const r = await maybeOne<PlantRowFull>(tx, `${SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('Plant');
  return r;
}
const contractYearRows = (tx: Tx, tenantId: string, plantId: string) =>
  many<{ year_no: number; start_date: string; end_date: string; days: number; fixed_fee: string; fee_configured: boolean }>(
    tx,
    `SELECT year_no, start_date, end_date, days, fixed_fee, fee_configured FROM app.contract_years
      WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no`,
    [tenantId, plantId],
  );

interface BillingSettings { invoiceLeadDays?: number; minPaymentTermsDays?: number }
interface SellerSettings { stateCode?: string }

/** Everything the wizard's Review step shows. Used by preview (no writes) and by create (same numbers). */
async function prepare(tx: Tx, input: PlantCreateInput) {
  const client = await maybeOne<{ id: string; display_name: string; state_code: string; status: string; account_state: string }>(
    tx, 'SELECT id, display_name, state_code, status, account_state FROM app.clients WHERE id = $1', [input.clientId]);
  if (!client || client.status === 'deleted') throw notFound('Client');
  if (client.status !== 'active' || client.account_state === 'terminated') {
    throw unprocessable('CLIENT_NOT_ACTIVE', 'Plants can only be added to an active client.');
  }
  const plan = await loadPlan(tx, input.subscription.planId);
  if (plan.status !== 'active') throw unprocessable('PLAN_ARCHIVED', 'This plan is archived and cannot be used for new subscriptions.');

  const omEnd = omEndDate(input.omStart, input.omTenureMonths);
  const misStart = input.misStart ?? input.omStart;
  if (misStart < input.omStart || misStart > omEnd) {
    throw unprocessable('MIS_START_OUT_OF_RANGE', 'MIS start date must be within the O&M contract period.', { field: 'misStart' });
  }
  const contractYears = buildContractYears(input.omStart, input.omTenureMonths);

  const today = todayIST();
  const sub = input.subscription;
  const startDate = sub.startDate;
  const endDate = subscriptionEndDate(startDate, plan.term_years);
  if (endDate < today) throw unprocessable('SUBSCRIPTION_ALREADY_ENDED', 'The subscription period has already ended.');
  const pricePerYear = sub.customPricePerYear ?? plan.price_per_year;
  const billing = await getSetting<BillingSettings>('billing', {});
  const seller = await getSetting<SellerSettings>('seller.company', {});
  const schedule = buildBillingSchedule({
    startDate, termYears: plan.term_years, billingMode: sub.billingMode, pricePerYear,
    escalationPct: plan.escalation_pct, upfrontDiscountPct: plan.upfront_discount_pct, today,
    invoiceLeadDays: billing.invoiceLeadDays ?? 30, minPaymentTermsDays: billing.minPaymentTermsDays ?? 7,
  });
  const first = schedule[0];
  if (!first) throw new Error('Empty billing schedule'); // impossible: termYears >= 1
  const sellerState = seller.stateCode || null;
  const intra = sellerState ? sellerState === client.state_code : null;

  const warnings: string[] = [];
  if (endDate > omEnd) warnings.push('SUBSCRIPTION_ENDS_AFTER_OM_END'); // SUB-02: allowed, but warn
  if (!sellerState) warnings.push('SELLER_STATE_NOT_CONFIGURED'); // GST split unknown until Settings → Company is filled

  const snapshot: PlanSnapshot = {
    planId: plan.id, name: plan.name, code: plan.code, termYears: plan.term_years, pricePerYear: plan.price_per_year,
    escalationPct: plan.escalation_pct, upfrontDiscountPct: plan.upfront_discount_pct,
    maxUsersPerPlant: plan.max_users_per_plant, maxManagementUsers: plan.max_management_users,
    storageGb: plan.storage_gb, features: plan.features,
  };
  return {
    client, plan, snapshot, omEnd, misStart, contractYears, startDate, endDate, pricePerYear, schedule, warnings,
    status: startDate > today ? 'scheduled' : 'active',
    firstInvoice: {
      ...gstSplit(first.amount, await gstRatePct(), intra),
      plannedInvoiceDate: first.plannedInvoiceDate, dueDate: first.dueDate,
    },
  };
}

function previewDto(input: PlantCreateInput, p: Awaited<ReturnType<typeof prepare>>) {
  return {
    plant: { omStart: input.omStart, omTenureMonths: input.omTenureMonths, omEnd: p.omEnd, misStart: p.misStart },
    contractYears: p.contractYears,
    subscription: {
      planId: p.plan.id, planName: p.plan.name, termYears: p.plan.term_years, startDate: p.startDate, endDate: p.endDate,
      billingMode: input.subscription.billingMode, pricePerYear: p.pricePerYear,
      escalationPct: Number(p.plan.escalation_pct), upfrontDiscountPct: Number(p.plan.upfront_discount_pct),
      totalExGst: sumAmounts(p.schedule), status: p.status,
    },
    schedule: p.schedule,
    firstInvoice: p.firstInvoice,
    warnings: p.warnings,
  };
}

export async function previewPlant(ctx: AdminTxCtx, input: PlantCreateInput) {
  return withAdmin(ctx, async (tx) => previewDto(input, await prepare(tx, input)));
}

async function nextPlantCode(tx: Tx, tenantId: string): Promise<string> {
  const { n } = await one<{ n: number }>(
    tx,
    `SELECT coalesce(max(substring(code from 3)::int), 0) + 1 AS n FROM app.plants
      WHERE tenant_id = $1 AND code ~ '^P-[0-9]+$'`,
    [tenantId],
  );
  return `P-${String(n).padStart(3, '0')}`;
}

/** PLT-01/02, SUB-01/03: plant + contract years + subscription (price-locked snapshot) + billing schedule, atomically. */
export async function createPlant(ctx: AdminTxCtx, input: PlantCreateInput, meta: RequestMeta) {
  const { plantId, warnings } = await withAdmin(ctx, async (tx) => {
    await tx.query('SELECT 1 FROM app.clients WHERE id = $1 FOR UPDATE', [input.clientId]); // serialises plant codes per client
    const p = await prepare(tx, input);
    const tenantId = p.client.id;
    const actor = adminActor(ctx.adminId, tenantId);
    if (input.code) {
      const taken = await maybeOne(tx, 'SELECT 1 FROM app.plants WHERE tenant_id = $1 AND code = $2', [tenantId, input.code]);
      if (taken) throw conflict('CODE_TAKEN', 'This plant code is already used for this client.');
    }
    const code = input.code ?? (await nextPlantCode(tx, tenantId));
    const { id } = await one<{ id: string }>(
      tx,
      `INSERT INTO app.plants (tenant_id, code, name, type, capacity_mld, city, state_code, om_start, om_tenure_months,
                               om_end, mis_start, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [tenantId, code, input.name, input.type, input.capacityMld, input.city ?? null, input.stateCode, input.omStart,
        input.omTenureMonths, p.omEnd, p.misStart, ctx.adminId],
    );
    // Settings row (filled by the Client Admin in Phase 2) and the cache-version row used by the engine.
    await exec(tx, 'INSERT INTO app.plant_settings (tenant_id, plant_id, report_company_name, created_by) VALUES ($1, $2, $3, $4)',
      [tenantId, id, p.client.display_name, ctx.adminId]);
    await exec(tx, 'INSERT INTO app.plant_data_versions (tenant_id, plant_id) VALUES ($1, $2)', [tenantId, id]);
    if (input.type === 'STP') await applyTemplate(tx, tenantId, id, p.misStart, ctx.adminId); // TPL-01
    for (const y of p.contractYears) {
      await exec(
        tx,
        `INSERT INTO app.contract_years (tenant_id, plant_id, year_no, start_date, end_date, days, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, id, y.yearNo, y.startDate, y.endDate, y.days, ctx.adminId],
      );
    }
    const sub = input.subscription;
    const { id: subscriptionId } = await one<{ id: string }>(
      tx,
      `INSERT INTO app.subscriptions (tenant_id, plant_id, plan_id, plan_snapshot, custom_price_per_year, custom_reason,
                                      start_date, end_date, billing_mode, status, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tenantId, id, p.plan.id, JSON.stringify(p.snapshot), sub.customPricePerYear ?? null, sub.customReason ?? null,
        p.startDate, p.endDate, sub.billingMode, p.status, ctx.adminId],
    );
    for (const r of p.schedule) {
      await exec(
        tx,
        `INSERT INTO app.billing_schedule (tenant_id, subscription_id, year_no, period_from, period_to, amount,
                                           planned_invoice_date, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, subscriptionId, r.yearNo, r.periodFrom, r.periodTo, r.amount, r.plannedInvoiceDate, r.dueDate],
      );
    }
    await exec(
      tx,
      `INSERT INTO app.lifecycle_events (tenant_id, plant_id, from_state, to_state, cause, note, actor_type, actor_id)
       VALUES ($1, $2, 'new', 'active', 'created', 'Plant created', 'super_admin', $3)`,
      [tenantId, id, ctx.adminId],
    );
    await writeAudit(tx, actor, {
      action: 'plant.create', entity: 'plant', entityId: id,
      after: { code, name: input.name, omStart: input.omStart, omTenureMonths: input.omTenureMonths, omEnd: p.omEnd },
    }, meta);
    await writeAudit(tx, actor, {
      action: 'subscription.create', entity: 'subscription', entityId: subscriptionId,
      after: { plan: p.snapshot, billingMode: sub.billingMode, startDate: p.startDate, endDate: p.endDate,
        customPricePerYear: sub.customPricePerYear ?? null, total: sumAmounts(p.schedule) },
      reason: sub.customReason ?? null,
    }, meta);
    return { plantId: id, warnings: p.warnings };
  });
  return { ...(await getPlant(ctx, plantId)), warnings };
}

export async function getPlant(ctx: AdminTxCtx, id: string) {
  return withAdmin(ctx, async (tx) => {
    const r = await loadPlant(tx, id);
    const years = await contractYearRows(tx, r.tenant_id, r.id);
    return {
      ...toPlantDto(r),
      contractYears: years.map((y) => ({
        yearNo: y.year_no, startDate: y.start_date, endDate: y.end_date, days: y.days,
        fixedFee: y.fixed_fee, feeConfigured: y.fee_configured,
      })),
      subscription: await currentSubscription(tx, r.tenant_id, r.id),
    };
  });
}

export async function listPlants(
  ctx: AdminTxCtx,
  q: { page: number; pageSize: number; q?: string; sort?: string; clientId?: string; accountState?: string; setupStatus?: string },
) {
  return withAdmin(ctx, async (tx) => {
    const where = `($1::uuid IS NULL OR p.tenant_id = $1)
       AND ($2::text IS NULL OR p.name ILIKE $2 OR p.code ILIKE $2 OR c.display_name ILIKE $2)
       AND ($3::text IS NULL OR p.account_state = $3)
       AND ($4::text IS NULL OR p.setup_status = $4)`;
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const params = [q.clientId ?? null, like, q.accountState ?? null, q.setupStatus ?? null];
    const { total } = await one<{ total: number }>(
      tx, `SELECT count(*) AS total ${PLANT_FROM} WHERE ${where}`, params);
    const sort = orderBy(q.sort, { name: 'p.name', client: 'c.display_name', omEnd: 'p.om_end', createdAt: 'p.created_at' },
      'c.display_name ASC, p.name ASC');
    const current = (col: string) => `(SELECT ${col} FROM app.subscriptions s
        WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id AND s.status IN ('active', 'scheduled')
        ORDER BY (s.status = 'active') DESC, s.start_date ASC LIMIT 1)`;
    const rows = await many<PlantRowFull & { plan_name: string | null; subscription_end: string | null }>(
      tx,
      `SELECT ${PLANT_COLS},
              ${current("s.plan_snapshot->>'name'")} AS plan_name,
              ${current('s.end_date')} AS subscription_end
         ${PLANT_FROM} WHERE ${where} ORDER BY ${sort} LIMIT $5 OFFSET $6`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      items: rows.map((r) => ({ ...toPlantDto(r), planName: r.plan_name, subscriptionEnd: r.subscription_end })),
      total,
    };
  });
}

/** PLT-04: name, type, capacity and location. O&M dates change only via extend-tenure (or Phase 2 settings). */
export async function updatePlant(
  ctx: AdminTxCtx,
  id: string,
  patch: { name?: string; type?: string; capacityMld?: number; city?: string | null; stateCode?: string },
  meta: RequestMeta,
) {
  await withAdmin(ctx, async (tx) => {
    const before = await loadPlant(tx, id, true);
    const set = setClause({
      name: patch.name, type: patch.type, capacity_mld: patch.capacityMld, city: patch.city, state_code: patch.stateCode,
    }, 3);
    if (set.values.length === 0) return;
    await exec(tx, `UPDATE app.plants SET ${set.sql} WHERE tenant_id = $1 AND id = $2`, [before.tenant_id, id, ...set.values]);
    const after = await loadPlant(tx, id);
    const pick = (r: PlantRowFull) => ({
      name: r.name, type: r.type, capacity_mld: r.capacity_mld, city: r.city, state_code: r.state_code,
    });
    await writeAudit(tx, adminActor(ctx.adminId, before.tenant_id), {
      action: 'plant.update', entity: 'plant', entityId: id, ...diff(pick(before), pick(after)),
    }, meta);
  });
  return getPlant(ctx, id);
}

/** PLT-04 / REV-07 / E08: longer tenure (≤ 180 months). Existing contract years keep their fees; new years are added. */
export async function extendTenure(
  ctx: AdminTxCtx, id: string, input: { omTenureMonths: number; reason: string }, meta: RequestMeta,
) {
  await withAdmin(ctx, async (tx) => {
    const p = await loadPlant(tx, id, true);
    if (input.omTenureMonths <= p.om_tenure_months) {
      throw unprocessable('TENURE_NOT_EXTENDED', 'The new tenure must be longer than the current one.');
    }
    const newEnd = omEndDate(p.om_start, input.omTenureMonths);
    await exec(
      tx, 'UPDATE app.plants SET om_tenure_months = $3, om_end = $4 WHERE tenant_id = $1 AND id = $2',
      [p.tenant_id, id, input.omTenureMonths, newEnd],
    );
    const existing = new Map((await contractYearRows(tx, p.tenant_id, id)).map((y) => [y.year_no, y]));
    for (const y of buildContractYears(p.om_start, input.omTenureMonths)) {
      const old = existing.get(y.yearNo);
      if (!old) {
        await exec(
          tx,
          `INSERT INTO app.contract_years (tenant_id, plant_id, year_no, start_date, end_date, days, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [p.tenant_id, id, y.yearNo, y.startDate, y.endDate, y.days, ctx.adminId],
        );
      } else if (old.end_date !== y.endDate) {
        // the previous partial last year becomes longer
        await exec(
          tx, 'UPDATE app.contract_years SET end_date = $4, days = $5 WHERE tenant_id = $1 AND plant_id = $2 AND year_no = $3',
          [p.tenant_id, id, y.yearNo, y.endDate, y.days],
        );
      }
    }
    await exec(
      tx, 'UPDATE app.plant_data_versions SET settings_version = settings_version + 1 WHERE tenant_id = $1 AND plant_id = $2',
      [p.tenant_id, id],
    );
    await writeAudit(tx, adminActor(ctx.adminId, p.tenant_id), {
      action: 'plant.extend_tenure', entity: 'plant', entityId: id,
      before: { omTenureMonths: p.om_tenure_months, omEnd: p.om_end },
      after: { omTenureMonths: input.omTenureMonths, omEnd: newEnd },
      reason: input.reason,
    }, meta);
    // Phase 2: enqueue derived-values recalculation for the plant after commit.
  });
  return getPlant(ctx, id);
}
