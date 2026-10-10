import { addDays, diffDays, maxDate, minDate, type ISODate } from '../../lib/dates';
import { D } from '../../lib/money';

export type LcState = 'active' | 'grace' | 'read_only' | 'suspended' | 'terminated' | 'expired';
export type ClientState = 'active' | 'grace' | 'read_only' | 'suspended' | 'terminated';
export const RANK: Record<LcState, number> = { active: 0, grace: 1, expired: 2, read_only: 3, suspended: 4, terminated: 5 };

export interface Window { from: ISODate; to: ISODate }
export interface OpenInvoice { id: string; number: string | null; dueDate: ISODate; balance: string; pauses: Window[] }
export interface SubSpan { start: ISODate; end: ISODate; status: string }
export interface PlantLifecycleInput {
  current: LcState;
  manualSuspended: boolean; // plant OR client flag
  holds: Window[];          // plant + client-level holds
  invoices: OpenInvoice[];  // issued & unpaid invoices of this plant (+ client-level manual invoices)
  subscriptions: SubSpan[];
  tolerance: string;
}
export interface LcRules { graceDays: number; readOnlyDays: number; suspendedDays: number; renewalWindowDays: number }
export interface Evaluation {
  state: LcState;
  cause: 'auto' | 'expiry' | 'hold' | 'manual';
  overdueDays: number;
  worstInvoiceId: string | null;
  expiredDays: number;
  nextChange: { on: ISODate; state: LcState } | null;
}

/** Number of days in (from, to] covered by at least one window (windows may overlap). */
export function coveredDays(from: ISODate, to: ISODate, windows: Window[]): number {
  if (to <= from) return 0;
  const lo = addDays(from, 1);
  const parts = windows
    .map((w) => ({ from: maxDate(w.from, lo), to: minDate(w.to, to) }))
    .filter((w) => w.from <= w.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let total = 0;
  let cur: Window | null = null;
  for (const w of parts) {
    if (cur && w.from <= addDays(cur.to, 1)) {
      if (w.to > cur.to) cur.to = w.to;
      continue;
    }
    if (cur) total += diffDays(cur.from, cur.to) + 1;
    cur = { ...w };
  }
  if (cur) total += diffDays(cur.from, cur.to) + 1;
  return total;
}

export function invoiceOverdueDays(inv: Pick<OpenInvoice, 'dueDate' | 'pauses'>, holds: Window[], on: ISODate): number {
  if (inv.dueDate >= on) return 0;
  return Math.max(0, diffDays(inv.dueDate, on) - coveredDays(inv.dueDate, on, [...inv.pauses, ...holds]));
}

export function stateForOverdue(days: number, r: LcRules): LcState {
  if (days <= 0) return 'active';
  if (days <= r.graceDays) return 'grace';
  if (days <= r.graceDays + r.readOnlyDays) return 'read_only';
  if (days <= r.graceDays + r.readOnlyDays + r.suspendedDays) return 'suspended';
  return 'terminated';
}
export function stateForExpiry(days: number, r: LcRules): LcState {
  if (days <= 0) return 'active';
  if (days <= r.renewalWindowDays) return 'expired';
  if (days <= r.renewalWindowDays + r.suspendedDays) return 'suspended';
  return 'terminated';
}

/** Days since the last subscription ended, when no subscription covers `on` (0 = covered or never started). */
export function expiredDays(subs: SubSpan[], on: ISODate): number {
  if (subs.some((s) => s.start <= on && on <= s.end)) return 0;
  const ended = subs.filter((s) => s.end < on).map((s) => s.end).sort();
  const last = ended[ended.length - 1];
  return last ? diffDays(last, on) : 0;
}

function stateOn(p: PlantLifecycleInput, on: ISODate, r: LcRules, allowFromTerminated: boolean) {
  if (p.current === 'terminated' && !allowFromTerminated) {
    return { state: 'terminated' as LcState, cause: 'auto' as const, od: 0, worst: null as string | null, ed: 0 };
  }
  const holdActive = p.holds.some((h) => h.from <= on && on <= h.to);
  let od = 0;
  let worst: string | null = null;
  for (const inv of p.invoices) {
    if (!D(inv.balance).gt(p.tolerance)) continue;
    const d = invoiceOverdueDays(inv, p.holds, on);
    if (d > od) {
      od = d;
      worst = inv.id;
    }
  }
  const ed = expiredDays(p.subscriptions, on);
  const pay: LcState = holdActive ? 'active' : stateForOverdue(od, r);
  const exp: LcState = holdActive ? 'active' : stateForExpiry(ed, r);
  let state: LcState = RANK[exp] > RANK[pay] ? exp : pay;
  let cause: Evaluation['cause'] = RANK[exp] > RANK[pay] ? 'expiry' : 'auto';
  if (holdActive && (od > 0 || ed > 0)) cause = 'hold';
  if (p.manualSuspended && RANK[state] < RANK.suspended) {
    state = 'suspended';
    cause = 'manual';
  }
  return { state, cause, od, worst, ed };
}

/** The plant's state on `today`, plus the next automatic change (scans up to 400 days ahead). */
export function evaluate(p: PlantLifecycleInput, today: ISODate, r: LcRules, opts: { allowFromTerminated?: boolean } = {}): Evaluation {
  const allow = opts.allowFromTerminated ?? false;
  const now = stateOn(p, today, r, allow);
  let nextChange: Evaluation['nextChange'] = null;
  if (now.state !== 'terminated') {
    const horizon = r.graceDays + r.readOnlyDays + r.suspendedDays + r.renewalWindowDays + 30;
    // From tomorrow on, the CURRENT state is the computed one (stickiness applies to future terminated states).
    const future = { ...p, current: now.state };
    for (let k = 1; k <= Math.min(horizon, 400); k++) {
      const d = addDays(today, k);
      const s = stateOn(future, d, r, false).state;
      if (s !== now.state) {
        nextChange = { on: d, state: s };
        break;
      }
    }
  }
  return { state: now.state, cause: now.cause, overdueDays: now.od, worstInvoiceId: now.worst, expiredDays: now.ed, nextChange };
}

/** PRD §9.1: the client shows its BEST plant state; Suspended only when all plants are suspended or terminated. */
export function rollupClientState(plantStates: LcState[], clientManualSuspended: boolean): ClientState {
  if (plantStates.length === 0) return clientManualSuspended ? 'suspended' : 'active';
  const best = plantStates.reduce((a, s) => (RANK[s] < RANK[a] ? s : a));
  const mapped: ClientState = best === 'expired' ? 'read_only' : best;
  if (clientManualSuspended && RANK[mapped] < RANK.suspended) return 'suspended';
  return mapped;
}
