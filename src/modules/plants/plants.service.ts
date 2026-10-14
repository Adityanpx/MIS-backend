import { many, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { currentSubscription } from '../admin/subscriptions/subscriptions.service';
import { plantUserUsage } from '../domain/plan-limits';

interface PlantListRow {
  id: string; code: string; name: string; type: string; capacity_mld: string; city: string | null; state_code: string;
  om_start: string; om_end: string; mis_start: string; setup_status: string; account_state: string; role: string;
  subscription_end: string | null;
}
const toDto = (r: PlantListRow) => ({
  id: r.id, code: r.code, name: r.name, type: r.type, capacityMld: Number(r.capacity_mld), city: r.city,
  stateCode: r.state_code, omStart: r.om_start, omEnd: r.om_end, misStart: r.mis_start, setupStatus: r.setup_status,
  accountState: r.account_state, myRole: r.role, subscriptionEnd: r.subscription_end,
});
const COLS = `p.id, p.code, p.name, p.type, p.capacity_mld, p.city, p.state_code, p.om_start, p.om_end, p.mis_start,
  p.setup_status, p.account_state,
  (SELECT s.end_date FROM app.subscriptions s
    WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id AND s.status IN ('active', 'scheduled')
    ORDER BY s.end_date DESC LIMIT 1) AS subscription_end`;

/** CA-01 home cards: a Client Admin (or a Management user, read-only) sees every plant; other users only plants they have a role on. */
export async function listPlants(ctx: ClientCtx) {
  return withTenant(tenantTx(ctx), async (tx) => {
    const rows = ctx.isClientAdmin || ctx.isManagement
      ? await many<PlantListRow>(
          tx, `SELECT ${COLS}, $2::text AS role FROM app.plants p WHERE p.tenant_id = $1 ORDER BY p.name`,
          [ctx.tenantId, ctx.isClientAdmin ? 'client_admin' : 'management'])
      : await many<PlantListRow>(
          tx,
          `SELECT ${COLS}, r.role FROM app.plants p
             JOIN app.user_plant_roles r ON r.tenant_id = p.tenant_id AND r.plant_id = p.id AND r.user_id = $2
            WHERE p.tenant_id = $1 ORDER BY p.name`,
          [ctx.tenantId, ctx.userId],
        );
    return rows.map(toDto);
  });
}

/** Plant summary. Subscription and user-limit details are shown to Client Admins only (billing information). */
export async function getPlant(ctx: ClientCtx, plant: PlantCtx) {
  return withTenant(tenantTx(ctx), async (tx) => {
    const r = await one<PlantListRow>(
      tx, `SELECT ${COLS}, $3::text AS role FROM app.plants p WHERE p.tenant_id = $1 AND p.id = $2`,
      [ctx.tenantId, plant.id, plant.myRole],
    );
    const years = await many<{ year_no: number; start_date: string; end_date: string; days: number; fee_configured: boolean }>(
      tx,
      `SELECT year_no, start_date, end_date, days, fee_configured FROM app.contract_years
        WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no`,
      [ctx.tenantId, plant.id],
    );
    const base = {
      ...toDto(r),
      contractYears: years.map((y) => ({
        yearNo: y.year_no, startDate: y.start_date, endDate: y.end_date, days: y.days, feeConfigured: y.fee_configured,
      })),
    };
    if (!ctx.isClientAdmin) return base;
    const sub = await currentSubscription(tx, ctx.tenantId, plant.id);
    const [usage] = await plantUserUsage(tx, ctx.tenantId, [plant.id], null);
    return {
      ...base,
      subscription: sub && {
        planName: sub.plan.name, termYears: sub.plan.termYears, startDate: sub.startDate, endDate: sub.endDate,
        billingMode: sub.billingMode, status: sub.status, features: sub.plan.features,
      },
      users: usage ? { used: usage.used, limit: usage.max_users } : null,
    };
  });
}
