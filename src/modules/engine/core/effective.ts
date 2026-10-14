import type { StandardKind } from '../../../shared/enums';
import type { Eff, ISODate, ParamDef, StandardRow } from './types';

export function valueAt<T>(rows: Eff<T>[], d: ISODate): T | undefined {
  let found: Eff<T> | undefined;
  for (const r of rows) if (r.from <= d && (!found || r.from >= found.from)) found = r;
  return (found ?? [...rows].sort((a, b) => (a.from < b.from ? -1 : 1))[0])?.v;
}
/**
 * v1.1 (STD-03): the effective standard of `kind` on `d`. When the resolved row has `inheritFromKind`
 * set, resolve from that OTHER kind's series instead (e.g. "Bidding inherits from Actual" until a
 * Bidding value is entered). An empty series (nothing ever entered for that kind) returns undefined —
 * STD-08: the Bidding series only exists once the Client Admin enters a value.
 */
export function standardAt(p: ParamDef, d: ISODate, kind: StandardKind): StandardRow | undefined {
  const row = valueAt(p.standardsByKind[kind].map((s) => ({ from: s.from, v: s })), d);
  if (row?.inheritFromKind) {
    return valueAt(p.standardsByKind[row.inheritFromKind].map((s) => ({ from: s.from, v: s })), d) ?? row;
  }
  return row;
}
export function isActive(p: ParamDef, d: ISODate): boolean {
  return (!p.activeFrom || p.activeFrom <= d) && (!p.activeTo || p.activeTo >= d);
}
