import { addDays, maxDate, minDate } from '../../../lib/dates';
import { evalFormula, orderCalculated, parseFormula, type FormulaNode } from '../../../shared/formula';
import { valueAt } from './effective';
import type { DerivedDay, DerivedMap, EngineData, EngineSettings, ISODate } from './types';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Calculated parameters in dependency order, parsed once. */
export function compileFormulas(s: EngineSettings): Array<{ code: string; node: FormulaNode }> {
  const formulas: Record<string, string> = {};
  for (const p of s.params) if (p.inputMode !== 'typed' && p.formula) formulas[p.code] = p.formula;
  return orderCalculated(formulas).map((code) => ({ code, node: parseFormula(formulas[code]!) }));
}

/** Value of a parameter on a day: typed value, else calculated value (null when no logsheet). */
export function dayValue(data: EngineData, derived: DerivedMap, code: string, d: ISODate): number | null {
  const rec = data.days.get(d);
  if (!rec) return null;
  const typed = num(rec.values[code]);
  if (typed !== null) return typed;
  return derived.get(d)?.calc[code] ?? null;
}

/**
 * Computes every day from the earliest opening date to `toDate`.
 * - stock: closing(d) = closing(d−1) − consumed(d) + received(d) + adjustments(d); closing(openingDate) = opening (§13.7)
 * - cash:  in_hand(d) = in_hand(d−1) − expense(d) + received(d) (§13.8)
 * - absent = strength(d) − vacant − present − leave (§13.5)
 * - revenue: FP_day + Σ rate × (std qty | actual qty) for every day inside a contract year (§13.10)
 */
export function computeDerived(s: EngineSettings, data: EngineData, toDate: ISODate): DerivedMap {
  const formulas = compileFormulas(s);
  const expense = s.params.find((p) => p.linkRole === 'expense')?.code;
  const received = s.params.find((p) => p.linkRole === 'cash_received')?.code;
  const starts = [s.cash.openingDate, ...s.stock.map((i) => i.openingDate), addDays(s.plant.misStart, -1)];
  let d = starts.reduce((a, b) => minDate(a, b));
  const end = minDate(toDate, s.plant.omEnd);
  const out: DerivedMap = new Map();
  const closing: Record<string, number | undefined> = {};
  let cash: number | undefined;
  const adj = new Map(s.stock.map((i) => [i.code, new Map<ISODate, number>()]));
  for (const i of s.stock) for (const a of i.adjustments) adj.get(i.code)!.set(a.date, (adj.get(i.code)!.get(a.date) ?? 0) + a.qty);

  while (d <= end) {
    const rec = data.days.get(d);
    const v = (code: string) => (rec ? num(rec.values[code]) : null);
    // calculated parameters (only on days with a logsheet)
    const calc: Record<string, number | null> = {};
    if (rec) {
      for (const f of formulas) {
        calc[f.code] = evalFormula(f.node, (ref) => {
          if (ref in calc) return calc[ref] ?? null;
          const typed = v(ref);
          if (typed !== null) return typed;
          const c = s.constants[ref];
          return c ? valueAt(c, d) ?? null : null;
        });
      }
    }
    // stock
    const stock: Record<string, number> = {};
    for (const i of s.stock) {
      if (d < i.openingDate) continue;
      const prev = closing[i.code];
      const next = d === i.openingDate || prev === undefined
        ? i.opening
        : prev - (v(i.consumedCode) ?? 0) + (v(i.receivedCode) ?? 0) + (adj.get(i.code)!.get(d) ?? 0);
      closing[i.code] = next;
      stock[i.code] = next;
    }
    // cash
    if (d >= s.cash.openingDate) {
      cash = d === s.cash.openingDate || cash === undefined
        ? s.cash.opening
        : cash - (expense ? v(expense) ?? 0 : 0) + (received ? v(received) ?? 0 : 0);
    }
    // staff absent
    const absent: Record<string, number> = {};
    if (rec) {
      for (const c of s.staff) {
        const strength = valueAt(c.strengths, d) ?? 0;
        absent[c.code] = strength - (v(c.vacantCode) ?? 0) - (v(c.presentCode) ?? 0) - (v(c.leaveCode) ?? 0);
      }
    }
    // revenue
    let revFp = 0;
    let revStd = 0;
    let revAct = 0;
    const year = d >= s.plant.misStart ? s.contractYears.find((y) => d >= y.start && d <= y.end) : undefined;
    if (year) {
      revFp = year.fixedFee / year.days;
      revStd = revFp;
      revAct = revFp;
      for (const c of year.components) {
        revStd += c.rate * c.stdQtyPerDay;
        const actual = rec ? (num(rec.values[c.paramCode]) ?? calc[c.paramCode] ?? 0) : 0;
        revAct += c.rate * actual;
      }
    }
    const day: DerivedDay = { calc, stock, cash: cash ?? 0, absent, revFp, revStd, revAct, hasData: !!rec };
    out.set(d, day);
    d = addDays(d, 1);
  }
  return out;
}

/** The last day worth computing: the latest logsheet or yesterday, never past the O&M end. */
export function lastComputeDate(s: EngineSettings, data: EngineData, today: ISODate): ISODate {
  let last = addDays(today, -1);
  for (const k of data.days.keys()) last = maxDate(last, k);
  return minDate(last, s.plant.omEnd);
}
