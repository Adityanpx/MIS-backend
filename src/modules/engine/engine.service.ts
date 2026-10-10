import { ENGINE_CACHE_MAX, ENGINE_CACHE_TTL_MS } from '../../config/constants';
import { maybeOne } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { todayIST } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { buildDashboard } from './core/dashboard';
import { computeDerived, lastComputeDate } from './core/derive';
import { buildMis, type Bundle } from './core/mis';
import { loadData, loadSettings } from './loader';

export interface VersionedBundle extends Bundle { tenantId: string; plantId: string; dataVersion: number; settingsVersion: number }
const cache = new Map<string, { at: number; b: VersionedBundle }>();

/** The key includes tenant + plant + both versions: a stale or foreign bundle can never be returned. */
export async function getBundle(tenantId: string, plantId: string): Promise<VersionedBundle> {
  return withTenant({ tenantId, actorId: null }, async (tx) => {
    const v = await maybeOne<{ data_version: number; settings_version: number }>(tx,
      'SELECT data_version, settings_version FROM app.plant_data_versions WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
    if (!v) throw notFound('Plant');
    const key = `${tenantId}:${plantId}:${v.data_version}:${v.settings_version}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ENGINE_CACHE_TTL_MS) {
      cache.delete(key); // LRU: re-insert at the end
      cache.set(key, hit);
      return hit.b;
    }
    const settings = await loadSettings(tx, tenantId, plantId);
    const data = await loadData(tx, tenantId, plantId);
    const derived = computeDerived(settings, data, lastComputeDate(settings, data, todayIST()));
    const b: VersionedBundle = { tenantId, plantId, settings, data, derived, dataVersion: v.data_version, settingsVersion: v.settings_version };
    for (const k of cache.keys()) if (k.startsWith(`${tenantId}:${plantId}:`)) cache.delete(k); // drop older versions
    cache.set(key, { at: Date.now(), b });
    while (cache.size > ENGINE_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return b;
  });
}

export async function misReport(tenantId: string, plantId: string, date: string) {
  const b = await getBundle(tenantId, plantId);
  return { ...buildMis(b, date), versions: { data: b.dataVersion, settings: b.settingsVersion } };
}
export async function dashboard(tenantId: string, plantId: string, date: string) {
  const b = await getBundle(tenantId, plantId);
  return { ...buildDashboard(b, date), versions: { data: b.dataVersion, settings: b.settingsVersion } };
}
/** Latest submitted date (MIS-01 default report date). */
export function latestDate(b: Bundle): string | null {
  let last: string | null = null;
  for (const k of b.data.days.keys()) if (!last || k > last) last = k;
  return last;
}
export function clearEngineCache(): void {
  cache.clear();
}
