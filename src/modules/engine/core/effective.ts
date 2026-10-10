import type { Eff, ISODate, ParamDef, StandardRow } from './types';

export function valueAt<T>(rows: Eff<T>[], d: ISODate): T | undefined {
  let found: Eff<T> | undefined;
  for (const r of rows) if (r.from <= d && (!found || r.from >= found.from)) found = r;
  return (found ?? [...rows].sort((a, b) => (a.from < b.from ? -1 : 1))[0])?.v;
}
export function standardAt(p: ParamDef, d: ISODate): StandardRow | undefined {
  return valueAt(p.standards.map((s) => ({ from: s.from, v: s })), d);
}
export function isActive(p: ParamDef, d: ISODate): boolean {
  return (!p.activeFrom || p.activeFrom <= d) && (!p.activeTo || p.activeTo >= d);
}
