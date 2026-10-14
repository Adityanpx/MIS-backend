import type { BreakdownRecord, ISODate, MaintenanceSettings } from './types';

export interface MaintenanceMetrics {
  reported: number;
  restored: number;
  openEndOfPeriod: number;
  criticalOpen: number;
  downtimeHrs: number;
  mttrHrs: number | null;
  availabilityPct: number | null;
  criticalAvailabilityPct: number | null;
  longestOpenDays: number | null;
}

/** IST day boundaries as epoch millis — pure, deterministic given the ISODate string (no wall-clock reads). */
const startOfIst = (d: ISODate): number => new Date(`${d}T00:00:00+05:30`).getTime();
const endOfIst = (d: ISODate): number => new Date(`${d}T23:59:59.999+05:30`).getTime();

/** MNT-06: a breakdown is "open as of D" when it started on/before D and was not yet restored by end of D. */
export function openAsOf(b: BreakdownRecord, d: ISODate): boolean {
  if (b.status === 'cancelled') return false;
  const started = new Date(b.startedAt).getTime();
  if (started > endOfIst(d)) return false;
  if (!b.restoredAt) return true;
  return new Date(b.restoredAt).getTime() > endOfIst(d);
}

/**
 * MNT-10: merges overlapping intervals of the SAME equipment, then sums the hours that fall inside
 * [from, to]. An open breakdown (no restoredAt) is capped at the end of the period, never "now" —
 * this keeps a past-date report deterministic (it never changes after the fact).
 */
export function downtimeHoursInPeriod(bds: BreakdownRecord[], from: ISODate, to: ISODate): number {
  const windowStart = startOfIst(from);
  const windowEnd = endOfIst(to);
  const byEquipment = new Map<string, Array<[number, number]>>();
  for (const b of bds) {
    if (b.status === 'cancelled') continue;
    const start = Math.max(windowStart, new Date(b.startedAt).getTime());
    const end = Math.min(windowEnd, b.restoredAt ? new Date(b.restoredAt).getTime() : windowEnd);
    if (end <= start) continue;
    const arr = byEquipment.get(b.equipmentId) ?? [];
    arr.push([start, end]);
    byEquipment.set(b.equipmentId, arr);
  }
  let hours = 0;
  for (const intervals of byEquipment.values()) {
    intervals.sort((a, b) => a[0] - b[0]);
    let [s, e] = intervals[0]!;
    for (let i = 1; i < intervals.length; i++) {
      const [nextStart, nextEnd] = intervals[i]!;
      if (nextStart <= e) e = Math.max(e, nextEnd);
      else {
        hours += (e - s) / 3_600_000;
        [s, e] = [nextStart, nextEnd];
      }
    }
    hours += (e - s) / 3_600_000;
  }
  return hours;
}

export function computeMetrics(
  bds: BreakdownRecord[], from: ISODate, to: ISODate, activeEquipmentCount: number, criticalEquipmentCount: number,
): MaintenanceMetrics {
  const periodMs = endOfIst(to) - startOfIst(from);
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= startOfIst(from) && t <= endOfIst(to);
  };
  const reported = bds.filter((b) => inWindow(b.startedAt)).length;
  const restoredSet = bds.filter((b) => b.restoredAt && inWindow(b.restoredAt));
  const restored = restoredSet.length;
  const openEndOfPeriod = bds.filter((b) => openAsOf(b, to)).length;
  const criticalOpen = bds.filter((b) => b.criticality === 'critical' && openAsOf(b, to)).length;
  const downtimeHrs = downtimeHoursInPeriod(bds, from, to);
  const criticalDowntimeHrs = downtimeHoursInPeriod(bds.filter((b) => b.criticality === 'critical'), from, to);
  const mttrHrs = restored > 0
    ? restoredSet.reduce((a, b) => a + (new Date(b.restoredAt!).getTime() - new Date(b.startedAt).getTime()) / 3_600_000, 0) / restored
    : null;
  const equipHours = activeEquipmentCount * (periodMs / 3_600_000);
  const availabilityPct = equipHours > 0 ? Math.max(0, 1 - downtimeHrs / equipHours) : null;
  const criticalEquipHours = criticalEquipmentCount * (periodMs / 3_600_000);
  const criticalAvailabilityPct = criticalEquipHours > 0 ? Math.max(0, 1 - criticalDowntimeHrs / criticalEquipHours) : null;
  const longestOpenDays = bds
    .filter((b) => openAsOf(b, to))
    .reduce<number | null>((max, b) => {
      const age = (endOfIst(to) - new Date(b.startedAt).getTime()) / 86_400_000;
      return max === null || age > max ? age : max;
    }, null);
  return { reported, restored, openEndOfPeriod, criticalOpen, downtimeHrs, mttrHrs, availabilityPct, criticalAvailabilityPct, longestOpenDays };
}

export interface MaintenanceTab {
  summary: {
    openNow: number; criticalOpen: number; restoredToday: number; downtimeMtd: number;
    availabilityMtd: number | null; availabilityUtd: number | null;
  };
  metrics: { today: MaintenanceMetrics; mtd: MaintenanceMetrics; utd: MaintenanceMetrics };
  openBreakdowns: BreakdownRecord[];
  restoredToday: BreakdownRecord[];
  topByDowntimeMtd: Array<{ equipmentId: string; equipmentCode: string; equipmentName: string; hours: number }>;
}

/** Builds the MIS tab 5 payload (§16A.7) from data already loaded by loader.ts — the engine core stays pure. */
export function buildMaintenanceTab(
  m: MaintenanceSettings, today: { from: ISODate; to: ISODate }, mtd: { from: ISODate; to: ISODate }, utd: { from: ISODate; to: ISODate },
): MaintenanceTab {
  const active = m.equipment.filter((e) => e.isActive);
  const activeCount = active.length;
  const criticalCount = active.filter((e) => e.criticality === 'critical').length;
  const todayM = computeMetrics(m.breakdowns, today.from, today.to, activeCount, criticalCount);
  const mtdM = computeMetrics(m.breakdowns, mtd.from, mtd.to, activeCount, criticalCount);
  const utdM = computeMetrics(m.breakdowns, utd.from, utd.to, activeCount, criticalCount);
  const byEquipmentMtd = new Map<string, number>();
  for (const e of active) {
    const hrs = downtimeHoursInPeriod(m.breakdowns.filter((b) => b.equipmentId === e.id), mtd.from, mtd.to);
    if (hrs > 0) byEquipmentMtd.set(e.id, hrs);
  }
  const topByDowntimeMtd = [...byEquipmentMtd.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([equipmentId, hours]) => {
      const e = active.find((x) => x.id === equipmentId)!;
      return { equipmentId, equipmentCode: e.code, equipmentName: e.name, hours };
    });
  return {
    summary: {
      openNow: utdM.openEndOfPeriod, criticalOpen: utdM.criticalOpen, restoredToday: todayM.restored,
      downtimeMtd: mtdM.downtimeHrs, availabilityMtd: mtdM.availabilityPct, availabilityUtd: utdM.availabilityPct,
    },
    metrics: { today: todayM, mtd: mtdM, utd: utdM },
    openBreakdowns: m.breakdowns.filter((b) => openAsOf(b, utd.to)),
    restoredToday: m.breakdowns.filter((b) => {
      if (!b.restoredAt) return false;
      const t = new Date(b.restoredAt).getTime();
      return t >= startOfIst(today.from) && t <= endOfIst(today.to);
    }),
    topByDowntimeMtd,
  };
}
