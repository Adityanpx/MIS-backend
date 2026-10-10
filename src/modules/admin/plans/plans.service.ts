import { exec, many, maybeOne, one, setClause } from '../../../db/sql';
import { isUniqueViolation } from '../../../db/errors';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import { conflict, notFound, unprocessable } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { DEFAULT_ALLOWED_PLAN_TERMS, DEFAULT_GST_RATE_PCT } from '../../../shared/constants';
import type { BillingMode } from '../../../shared/enums';
import { adminActor, diff, writeAudit } from '../../audit/audit.service';
import { priceTable } from '../../domain/pricing';
import { getSetting } from '../../platform/settings.service';

export interface PlanDto {
  id: string; name: string; code: string; description: string | null; termYears: number; pricePerYear: string;
  escalationPct: number; upfrontDiscountPct: number; maxUsersPerPlant: number; storageGb: number;
  features: Record<string, boolean>; status: string; subscriptionsCount: number; createdAt: string;
}
export interface PlanRowFull {
  id: string; name: string; code: string; description: string | null; term_years: number; price_per_year: string;
  escalation_pct: string; upfront_discount_pct: string; max_users_per_plant: number; storage_gb: number;
  features: Record<string, boolean>; status: string; created_at: string; subscriptions_count: number;
}
const SELECT = `
  SELECT p.id, p.name, p.code, p.description, p.term_years, p.price_per_year, p.escalation_pct, p.upfront_discount_pct,
         p.max_users_per_plant, p.storage_gb, p.features, p.status, p.created_at,
         (SELECT count(*) FROM app.subscriptions s WHERE s.plan_id = p.id) AS subscriptions_count
    FROM app.plans p`;
export const toPlanDto = (r: PlanRowFull): PlanDto => ({
  id: r.id, name: r.name, code: r.code, description: r.description, termYears: r.term_years,
  pricePerYear: r.price_per_year, escalationPct: Number(r.escalation_pct), upfrontDiscountPct: Number(r.upfront_discount_pct),
  maxUsersPerPlant: r.max_users_per_plant, storageGb: r.storage_gb, features: r.features, status: r.status,
  subscriptionsCount: r.subscriptions_count, createdAt: r.created_at,
});

export async function gstRatePct(): Promise<number> {
  return (await getSetting<{ gstRatePct?: number }>('tax', {})).gstRatePct ?? DEFAULT_GST_RATE_PCT;
}
/** PRD PLN-01: allowed term values come from Settings (default 5/10/15) and never exceed 15. */
export async function assertTermAllowed(termYears: number): Promise<void> {
  const allowed = await getSetting<number[]>('plans.allowed_terms', [...DEFAULT_ALLOWED_PLAN_TERMS]);
  if (!allowed.includes(termYears)) {
    throw unprocessable('TERM_NOT_ALLOWED', `Allowed plan terms: ${allowed.join(', ')} years.`);
  }
}
export async function loadPlan(tx: Tx, id: string): Promise<PlanRowFull> {
  const r = await maybeOne<PlanRowFull>(tx, `${SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('Plan');
  return r;
}

export async function listPlans(ctx: AdminTxCtx, status?: string): Promise<PlanDto[]> {
  return withAdmin(ctx, async (tx) =>
    (await many<PlanRowFull>(tx, `${SELECT} WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.term_years, p.name`, [status ?? null]))
      .map(toPlanDto),
  );
}
export async function getPlan(ctx: AdminTxCtx, id: string): Promise<PlanDto> {
  return withAdmin(ctx, async (tx) => toPlanDto(await loadPlan(tx, id)));
}

export interface PlanInput {
  name: string; code: string; description?: string; termYears: number; pricePerYear: string; escalationPct: number;
  upfrontDiscountPct: number; maxUsersPerPlant: number; storageGb: number; features: Record<string, boolean>;
}
export async function createPlan(ctx: AdminTxCtx, input: PlanInput, meta: RequestMeta): Promise<PlanDto> {
  await assertTermAllowed(input.termYears);
  try {
    return await withAdmin(ctx, async (tx) => {
      const { id } = await one<{ id: string }>(
        tx,
        `INSERT INTO app.plans (name, code, description, term_years, price_per_year, escalation_pct, upfront_discount_pct,
                                max_users_per_plant, storage_gb, features, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
        [input.name, input.code, input.description ?? null, input.termYears, input.pricePerYear, input.escalationPct,
          input.upfrontDiscountPct, input.maxUsersPerPlant, input.storageGb, JSON.stringify(input.features), ctx.adminId],
      );
      const dto = toPlanDto(await loadPlan(tx, id));
      await writeAudit(tx, adminActor(ctx.adminId), { action: 'plan.create', entity: 'plan', entityId: id, after: dto }, meta);
      return dto;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'plans_code_key')) throw conflict('CODE_TAKEN', 'A plan with this code already exists.');
    throw err;
  }
}

/** PLN-03: editing a plan never changes existing subscriptions (they keep their snapshot). */
export async function updatePlan(
  ctx: AdminTxCtx, id: string, patch: Partial<Omit<PlanInput, 'code'>>, meta: RequestMeta,
): Promise<PlanDto> {
  if (patch.termYears !== undefined) await assertTermAllowed(patch.termYears);
  return withAdmin(ctx, async (tx) => {
    const before = toPlanDto(await loadPlan(tx, id));
    const set = setClause({
      name: patch.name, description: patch.description, term_years: patch.termYears, price_per_year: patch.pricePerYear,
      escalation_pct: patch.escalationPct, upfront_discount_pct: patch.upfrontDiscountPct,
      max_users_per_plant: patch.maxUsersPerPlant, storage_gb: patch.storageGb,
      features: patch.features === undefined ? undefined : JSON.stringify(patch.features),
    }, 2);
    if (set.values.length === 0) return before;
    await exec(tx, `UPDATE app.plans SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
    const after = toPlanDto(await loadPlan(tx, id));
    await writeAudit(tx, adminActor(ctx.adminId), {
      action: 'plan.update', entity: 'plan', entityId: id,
      ...diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
    }, meta);
    return after;
  });
}

/** PLN-04: archived plans can't be chosen for new subscriptions. Plans are never deleted. */
export async function setPlanStatus(
  ctx: AdminTxCtx, id: string, status: 'active' | 'archived', meta: RequestMeta,
): Promise<PlanDto> {
  return withAdmin(ctx, async (tx) => {
    await loadPlan(tx, id);
    await exec(tx, 'UPDATE app.plans SET status = $2 WHERE id = $1', [id, status]);
    await writeAudit(tx, adminActor(ctx.adminId), {
      action: status === 'archived' ? 'plan.archive' : 'plan.restore', entity: 'plan', entityId: id,
    }, meta);
    return toPlanDto(await loadPlan(tx, id));
  });
}

export async function previewPlan(input: {
  termYears: number; pricePerYear: string; escalationPct: number; upfrontDiscountPct: number;
  billingMode: BillingMode; startDate?: string;
}) {
  return priceTable({ ...input, gstRatePct: await gstRatePct() });
}
