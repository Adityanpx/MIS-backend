import { env } from '../../config/env';
import { exec, many, maybeOne, one } from '../../db/sql';
import { withAdmin, withTenant, type AdminTxCtx, type Tx } from '../../db/tenant';
import { addDays, formatDisplayDate, todayIST, type ISODate } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { D, money } from '../../lib/money';
import type { RequestMeta } from '../../lib/request-meta';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { formatMoney } from '../../shared/format';
import type { ClientCtx } from '../../types/express';
import { adminActor, writeAudit, type AuditActor } from '../audit/audit.service';
import { DEFAULT_LIFECYCLE, DEFAULT_TAX, loadBillingConfig, type LifecycleSettings } from '../billing/billing-config';
import { notifyClientBilling } from '../billing/billing-notify';
import { markOverdue } from '../billing/invoice-totals';
import { sendInBackground } from '../notifications/email.service';
import { getSetting } from '../platform/settings.service';
import { evaluate, rollupClientState, type Evaluation, type LcState, type PlantLifecycleInput, type Window } from './evaluate';

export interface PlantMeta { id: string; name: string; account_state: LcState; manual_suspended: boolean; setup_status: string }
export interface LoadedPlant { plant: PlantMeta; input: PlantLifecycleInput }
interface InvoiceRowLc { id: string; number: string | null; due_date: string; balance: string; plant_ids: string[]; rzp_link_url: string | null }

export async function loadLifecycleInputs(
  tx: Tx, tenantId: string, today: ISODate, lc: LifecycleSettings, tolerance: string,
): Promise<{ plants: LoadedPlant[]; invoices: InvoiceRowLc[]; clientManual: boolean }> {
  const client = await one<{ manual_suspended: boolean }>(tx, 'SELECT manual_suspended FROM app.clients WHERE id = $1', [tenantId]);
  const plants = await many<PlantMeta>(
    tx, 'SELECT id, name, account_state, manual_suspended, setup_status FROM app.plants WHERE tenant_id = $1 ORDER BY name', [tenantId]);
  const invoices = await many<InvoiceRowLc>(
    tx,
    `SELECT i.id, i.number, i.due_date, i.balance, i.rzp_link_url,
            coalesce(array_agg(DISTINCT l.plant_id) FILTER (WHERE l.plant_id IS NOT NULL), '{}') AS plant_ids
       FROM app.invoices i
       LEFT JOIN app.invoice_lines l ON l.tenant_id = i.tenant_id AND l.invoice_id = i.id
      WHERE i.tenant_id = $1 AND i.status IN ('issued', 'partially_paid', 'overdue') AND i.balance > 0 AND i.due_date IS NOT NULL
      GROUP BY i.id ORDER BY i.due_date`,
    [tenantId],
  );
  const cheques = await many<{ invoice_id: string; payment_date: string; status: string; bounced_on: string | null }>(
    tx,
    `SELECT a.invoice_id, p.payment_date, p.status, (p.bounced_at AT TIME ZONE 'Asia/Kolkata')::date AS bounced_on
       FROM app.payments p
       JOIN app.payment_allocations a ON a.tenant_id = p.tenant_id AND a.payment_id = p.id
      WHERE p.tenant_id = $1 AND p.mode = 'cheque' AND p.status IN ('pending_clearance', 'bounced') AND a.invoice_id IS NOT NULL`,
    [tenantId],
  );
  const holds = await many<{ plant_id: string | null; from_date: string; until_date: string }>(
    tx, 'SELECT plant_id, from_date, until_date FROM app.lifecycle_holds WHERE tenant_id = $1', [tenantId]);
  const subs = await many<{ plant_id: string; start_date: string; end_date: string; status: string }>(
    tx, 'SELECT plant_id, start_date, end_date, status FROM app.subscriptions WHERE tenant_id = $1', [tenantId]);

  // OFF-02: a cheque pauses the clock of its invoices from the cheque date for at most chequePauseMaxDays (until bounce).
  const pausesByInvoice = new Map<string, Window[]>();
  for (const c of cheques) {
    const maxTo = addDays(c.payment_date, lc.chequePauseMaxDays - 1);
    const to = c.status === 'bounced' && c.bounced_on && c.bounced_on < maxTo ? c.bounced_on : maxTo;
    const list = pausesByInvoice.get(c.invoice_id) ?? [];
    list.push({ from: c.payment_date, to });
    pausesByInvoice.set(c.invoice_id, list);
  }
  return {
    clientManual: client.manual_suspended,
    invoices,
    plants: plants.map((p) => ({
      plant: p,
      input: {
        current: p.account_state,
        manualSuspended: p.manual_suspended || client.manual_suspended,
        holds: holds.filter((h) => h.plant_id === null || h.plant_id === p.id).map((h) => ({ from: h.from_date, to: h.until_date })),
        invoices: invoices
          .filter((i) => i.plant_ids.length === 0 || i.plant_ids.includes(p.id)) // decision 0.3-5
          .map((i) => ({ id: i.id, number: i.number, dueDate: i.due_date, balance: i.balance, pauses: pausesByInvoice.get(i.id) ?? [] })),
        subscriptions: subs.filter((s) => s.plant_id === p.id).map((s) => ({ start: s.start_date, end: s.end_date, status: s.status })),
        tolerance,
      },
    })),
  };
}

export interface StateChange { plantId: string; plantName: string; from: LcState; to: LcState; evaluation: Evaluation }
export interface EvaluateOptions {
  actor: AuditActor;
  today?: ISODate;
  allowFromTerminated?: string[]; // plant ids (Super Admin reactivation, LC-03)
  cause?: 'payment' | 'manual' | 'hold';
  note?: string;
}

const NOTICE: Partial<Record<LcState, string>> = { read_only: 'N-B04', suspended: 'N-B05', terminated: 'N-B06', expired: 'N-B10' };

/** Evaluates all plants of one tenant and persists changes. Call INSIDE the caller's (admin/system) transaction. */
export async function evaluateTenant(tx: Tx, tenantId: string, o: EvaluateOptions): Promise<{ changes: StateChange[]; outbox: Array<string | null> }> {
  const today = o.today ?? todayIST();
  const cfg = await loadBillingConfig(tx);
  const client = await one<{ status: string; terminated_at: string | null }>(
    tx, 'SELECT status, terminated_at FROM app.clients WHERE id = $1', [tenantId]);
  if (client.status !== 'active') return { changes: [], outbox: [] }; // scheduled for deletion / deleted: frozen
  await markOverdue(tx, tenantId, today);
  const { plants, invoices, clientManual } = await loadLifecycleInputs(tx, tenantId, today, cfg.lifecycle, cfg.tax.closeTolerance);
  const changes: StateChange[] = [];
  const outbox: Array<string | null> = [];
  const finalStates: LcState[] = [];
  for (const { plant, input } of plants) {
    if (plant.setup_status === 'closed') continue; // PLT-08: closed plants keep their last state
    const ev = evaluate(input, today, cfg.lifecycle, { allowFromTerminated: o.allowFromTerminated?.includes(plant.id) });
    finalStates.push(ev.state);
    if (ev.state === plant.account_state) continue;
    await exec(tx, 'UPDATE app.plants SET account_state = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, plant.id, ev.state]);
    const cause = o.cause ?? (ev.cause === 'expiry' ? 'expiry' : ev.cause === 'hold' ? 'hold' : ev.cause === 'manual' ? 'manual' : 'auto');
    await exec(
      tx,
      `INSERT INTO app.lifecycle_events (tenant_id, plant_id, from_state, to_state, cause, note, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, plant.id, plant.account_state, ev.state, cause, o.note ?? null, o.actor.actorType, o.actor.actorId],
    );
    changes.push({ plantId: plant.id, plantName: plant.name, from: plant.account_state, to: ev.state, evaluation: ev });

    // Transition notices (idempotent per plant per day).
    const worst = invoices.find((i) => i.id === ev.worstInvoiceId);
    const vars = {
      plantName: plant.name,
      amount: worst ? formatMoney(worst.balance) : '',
      dueDate: worst ? formatDisplayDate(worst.due_date) : '',
      nextDate: ev.nextChange ? formatDisplayDate(ev.nextChange.on) : '',
      payLink: worst?.rzp_link_url ?? `${env.PUBLIC_WEB_URL}/billing`,
      exportUntil: formatDisplayDate(addDays(today, cfg.lifecycle.retentionDays)),
      planName: '', endDate: formatDisplayDate(today), status: 'ended', statusText: 'ended',
    };
    if (ev.state === 'active') {
      outbox.push(...await notifyClientBilling(tx, {
        tenantId, code: 'N-B08', title: `${plant.name}: account reactivated`, body: 'The account is active again.',
        vars, dedupeKey: `N-B08:${plant.id}:${today}`,
      }));
    } else {
      const code = NOTICE[ev.state];
      if (code) {
        outbox.push(...await notifyClientBilling(tx, {
          tenantId, code, title: `${plant.name}: account ${ev.state.replace('_', '-')}`,
          body: ev.state === 'expired' ? 'The subscription has ended. Renew to continue.' : `Overdue ${vars.amount} since ${vars.dueDate}.`,
          vars, dedupeKey: `${code}:${plant.id}:${today}`,
        }));
      }
    }
  }
  // Client roll-up (PRD §9.1)
  const rolled = rollupClientState(finalStates, clientManual);
  await exec(
    tx,
    `UPDATE app.clients SET account_state = $2,
            terminated_at = CASE WHEN $2 = 'terminated' THEN coalesce(terminated_at, now()) ELSE terminated_at END
      WHERE id = $1 AND account_state IS DISTINCT FROM $2`,
    [tenantId, rolled],
  );
  return { changes, outbox };
}

/** Lifecycle rules read OUTSIDE a transaction (client requests: app_user can't read platform_settings). */
export async function lifecycleRulesCached() {
  const lc = { ...DEFAULT_LIFECYCLE, ...(await getSetting<Partial<LifecycleSettings>>('lifecycle', {})) };
  const tax = { ...DEFAULT_TAX, ...(await getSetting<Partial<typeof DEFAULT_TAX>>('tax', {})) };
  return { lc, tolerance: tax.closeTolerance };
}

// ------------------------------------------------------------------ banners (PRD §9.2, §10.5)
const MESSAGES: Record<string, string> = {
  grace: 'Payment of {amount} is overdue since {since}. Please pay by {by} to avoid restriction.',
  read_only: 'Account is read-only due to an unpaid invoice. Pay to restore data entry.',
  suspended: 'Account is suspended.',
  terminated: 'Account has been terminated.',
  expired: 'Subscription has ended. Renew to continue.',
};
export async function bannersFor(ctx: ClientCtx) {
  const { lc, tolerance } = await lifecycleRulesCached();
  const today = todayIST();
  return withTenant({ tenantId: ctx.tenantId, actorId: ctx.userId }, async (tx) => {
    const { plants } = await loadLifecycleInputs(tx, ctx.tenantId, today, lc, tolerance);
    return plants
      .filter((p) => (ctx.isClientAdmin || ctx.plantRoles[p.plant.id]) && p.plant.account_state !== 'active' && p.plant.setup_status !== 'closed')
      .map(({ plant, input }) => {
        const ev = evaluate(input, today, lc);
        const overdue = input.invoices.filter((i) => i.dueDate < today && D(i.balance).gt(tolerance));
        const amount = money(overdue.reduce((s, i) => s.plus(i.balance), D(0)));
        const since = overdue[0]?.dueDate ?? null;
        const by = ev.nextChange ? addDays(ev.nextChange.on, -1) : null;
        const text = (MESSAGES[plant.account_state] ?? '')
          .replace('{amount}', formatMoney(amount)).replace('{since}', since ? formatDisplayDate(since) : '')
          .replace('{by}', by ? formatDisplayDate(by) : '');
        return {
          plantId: plant.id, plantName: plant.name, state: plant.account_state,
          level: plant.account_state === 'grace' ? 'yellow' : ['read_only', 'expired'].includes(plant.account_state) ? 'orange' : 'red',
          message: ctx.isClientAdmin ? text : `${text.split('.')[0]}. Please contact your administrator.`,
          overdueAmount: ctx.isClientAdmin ? amount : null,
          overdueSince: since,
          nextChange: ev.nextChange,
          showPayNow: ctx.isClientAdmin && overdue.length > 0,
        };
      });
  });
}

// ------------------------------------------------------------------ manual actions (Super Admin)
type Target = { kind: 'plant' | 'client'; id: string };

async function resolveTenant(tx: Tx, t: Target): Promise<{ tenantId: string; plantIds: string[] }> {
  if (t.kind === 'client') {
    const c = await maybeOne<{ id: string }>(tx, `SELECT id FROM app.clients WHERE id = $1 AND status <> 'deleted' FOR UPDATE`, [t.id]);
    if (!c) throw notFound('Client');
    const plants = await many<{ id: string }>(tx, 'SELECT id FROM app.plants WHERE tenant_id = $1', [c.id]);
    return { tenantId: c.id, plantIds: plants.map((p) => p.id) };
  }
  const p = await maybeOne<{ tenant_id: string }>(
    tx,
    `SELECT p.tenant_id FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
      WHERE p.id = $1 AND c.status <> 'deleted' FOR UPDATE OF p`,
    [t.id],
  );
  if (!p) throw notFound('Plant');
  return { tenantId: p.tenant_id, plantIds: [t.id] };
}

async function finish(outbox: Array<string | null>) {
  invalidateClientAuthCache();
  sendInBackground(outbox);
}

/** LC-04: manual suspend (reason required). Not lifted by payments. */
export async function suspend(ctx: AdminTxCtx, t: Target, reason: string, meta: RequestMeta) {
  const outbox = await withAdmin(ctx, async (tx) => {
    const { tenantId } = await resolveTenant(tx, t);
    const table = t.kind === 'client' ? 'app.clients' : 'app.plants';
    const where = t.kind === 'client' ? 'id = $1' : 'tenant_id = $2 AND id = $1';
    await exec(tx, `UPDATE ${table} SET manual_suspended = true WHERE ${where}`, t.kind === 'client' ? [t.id] : [t.id, tenantId]);
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, { action: `${t.kind}.suspend`, entity: t.kind, entityId: t.id, reason }, meta);
    return (await evaluateTenant(tx, tenantId, { actor, cause: 'manual', note: reason })).outbox;
  });
  await finish(outbox);
}

/** LC-03/04: clears manual suspension; a terminated plant is reactivated only when no dues remain and data exists. */
export async function reactivate(ctx: AdminTxCtx, t: Target, reason: string, meta: RequestMeta) {
  const outbox = await withAdmin(ctx, async (tx) => {
    const { tenantId, plantIds } = await resolveTenant(tx, t);
    const cfg = await loadBillingConfig(tx);
    const terminated = await many<{ id: string }>(
      tx, `SELECT id FROM app.plants WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND account_state = 'terminated'`, [tenantId, plantIds]);
    if (terminated.length > 0) {
      const dues = await one<{ n: number }>(
        tx,
        `SELECT count(*) AS n FROM app.invoices WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid', 'overdue')
            AND balance > $2 AND due_date < $3`,
        [tenantId, cfg.tax.closeTolerance, todayIST()],
      );
      if (dues.n > 0) throw conflict('DUES_OUTSTANDING', 'Overdue invoices must be paid before a terminated account can be reactivated.');
    }
    if (t.kind === 'client') {
      await exec(tx, 'UPDATE app.clients SET manual_suspended = false, terminated_at = NULL WHERE id = $1', [tenantId]);
      await exec(tx, 'UPDATE app.plants SET manual_suspended = false WHERE tenant_id = $1', [tenantId]);
    } else {
      await exec(tx, 'UPDATE app.plants SET manual_suspended = false WHERE tenant_id = $1 AND id = $2', [tenantId, t.id]);
      await exec(tx, 'UPDATE app.clients SET terminated_at = NULL WHERE id = $1', [tenantId]);
    }
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, { action: `${t.kind}.reactivate`, entity: t.kind, entityId: t.id, reason }, meta);
    return (await evaluateTenant(tx, tenantId, {
      actor, cause: 'manual', note: reason, allowFromTerminated: terminated.map((x) => x.id),
    })).outbox;
  });
  await finish(outbox);
}

/** LC-05: pause automatic suspension until a date (null = end the hold today). */
export async function hold(ctx: AdminTxCtx, t: Target, until: ISODate | null, reason: string, meta: RequestMeta) {
  const today = todayIST();
  if (until && until < today) throw unprocessable('HOLD_IN_PAST', 'The hold date must be today or later.');
  const outbox = await withAdmin(ctx, async (tx) => {
    const { tenantId } = await resolveTenant(tx, t);
    const plantId = t.kind === 'plant' ? t.id : null;
    const scope = 'tenant_id = $1 AND plant_id IS NOT DISTINCT FROM $2';
    if (until === null) {
      await exec(tx, `DELETE FROM app.lifecycle_holds WHERE ${scope} AND from_date >= $3`, [tenantId, plantId, today]);
      await exec(tx, `UPDATE app.lifecycle_holds SET until_date = $3::date - 1 WHERE ${scope} AND until_date >= $3`, [tenantId, plantId, today]);
    } else {
      await exec(tx, `DELETE FROM app.lifecycle_holds WHERE ${scope} AND from_date >= $3`, [tenantId, plantId, today]);
      await exec(tx, `UPDATE app.lifecycle_holds SET until_date = $3::date - 1 WHERE ${scope} AND until_date >= $3`, [tenantId, plantId, today]);
      await exec(
        tx,
        `INSERT INTO app.lifecycle_holds (tenant_id, plant_id, from_date, until_date, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, plantId, today, until, reason, ctx.adminId],
      );
    }
    if (t.kind === 'client') await exec(tx, 'UPDATE app.clients SET hold_until = $2 WHERE id = $1', [tenantId, until]);
    else await exec(tx, 'UPDATE app.plants SET hold_until = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, t.id, until]);
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, { action: `${t.kind}.hold`, entity: t.kind, entityId: t.id, after: { until }, reason }, meta);
    return (await evaluateTenant(tx, tenantId, { actor, cause: 'hold', note: reason })).outbox;
  });
  await finish(outbox);
}

/** CL-08: terminate a client now (all plants). Data stays until the deletion flow (§9.7). */
export async function terminateClient(ctx: AdminTxCtx, clientId: string, reason: string, meta: RequestMeta) {
  const outbox = await withAdmin(ctx, async (tx) => {
    const { tenantId } = await resolveTenant(tx, { kind: 'client', id: clientId });
    const cfg = await loadBillingConfig(tx);
    const plants = await many<{ id: string; name: string; account_state: string }>(
      tx, `SELECT id, name, account_state FROM app.plants WHERE tenant_id = $1 AND account_state <> 'terminated'`, [tenantId]);
    for (const p of plants) {
      await exec(tx, `UPDATE app.plants SET account_state = 'terminated' WHERE tenant_id = $1 AND id = $2`, [tenantId, p.id]);
      await exec(
        tx,
        `INSERT INTO app.lifecycle_events (tenant_id, plant_id, from_state, to_state, cause, note, actor_type, actor_id)
         VALUES ($1, $2, $3, 'terminated', 'manual', $4, 'super_admin', $5)`,
        [tenantId, p.id, p.account_state, reason, ctx.adminId],
      );
    }
    await exec(tx, `UPDATE app.clients SET account_state = 'terminated', terminated_at = coalesce(terminated_at, now()) WHERE id = $1`, [tenantId]);
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, { action: 'client.terminate', entity: 'client', entityId: tenantId, reason }, meta);
    return notifyClientBilling(tx, {
      tenantId, code: 'N-B06', title: 'Account terminated', body: 'Your account has been terminated.',
      vars: { plantName: 'all plants', exportUntil: formatDisplayDate(addDays(todayIST(), cfg.lifecycle.retentionDays)) },
      dedupeKey: `N-B06:client:${todayIST()}`,
    });
  });
  await finish(outbox);
}

/** PLT-08: close a plant whose contract/subscription has ended. Closed plants stay viewable. */
export async function closePlant(ctx: AdminTxCtx, plantId: string, reason: string, meta: RequestMeta) {
  const outbox = await withAdmin(ctx, async (tx) => {
    const { tenantId } = await resolveTenant(tx, { kind: 'plant', id: plantId });
    const active = await one<{ n: number }>(
      tx,
      `SELECT count(*) AS n FROM app.subscriptions WHERE tenant_id = $1 AND plant_id = $2 AND status IN ('active', 'scheduled')
          AND end_date >= $3`,
      [tenantId, plantId, todayIST()],
    );
    if (active.n > 0) throw conflict('PLANT_HAS_ACTIVE_SUBSCRIPTION', 'Cancel or end the subscription before closing the plant.');
    await exec(tx, `UPDATE app.plants SET setup_status = 'closed', closed_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, plantId]);
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, { action: 'plant.close', entity: 'plant', entityId: plantId, reason }, meta);
    return (await evaluateTenant(tx, tenantId, { actor, cause: 'manual', note: reason })).outbox;
  });
  await finish(outbox);
}

/** LC-09 timeline for the client detail page. */
export async function lifecycleHistory(ctx: AdminTxCtx, clientId: string) {
  return withAdmin(ctx, async (tx) => {
    const c = await maybeOne(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [clientId]);
    if (!c) throw notFound('Client');
    return many(
      tx,
      `SELECT e.id, e.plant_id AS "plantId", p.name AS "plantName", e.from_state AS "from", e.to_state AS "to", e.cause, e.note,
              e.actor_type AS "actorType", e.actor_id AS "actorId", e.at
         FROM app.lifecycle_events e LEFT JOIN app.plants p ON p.tenant_id = e.tenant_id AND p.id = e.plant_id
        WHERE e.tenant_id = $1 ORDER BY e.at DESC LIMIT 500`,
      [clientId],
    );
  });
}
