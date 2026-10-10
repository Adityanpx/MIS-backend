import { withSystem } from '../../db/tenant';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await withSystem(async (tx) => {
    const r = await tx.query<{ value: T }>('SELECT value FROM app.platform_settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? fallback;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function clearSettingsCache(): void {
  cache.clear();
}
export async function currentTermsVersion(): Promise<string> {
  const terms = await getSetting<{ version?: string }>('legal.terms', {});
  return terms.version ?? '';
}
export async function platformName(): Promise<string> {
  const b = await getSetting<{ name?: string }>('platform.branding', {});
  return b.name ?? 'OMMIS';
}
