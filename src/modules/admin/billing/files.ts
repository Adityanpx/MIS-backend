import { conflict } from '../../../lib/errors';
import { assertTenantKey, storage } from '../../files/storage';

/** A signed download URL for a stored billing file, after re-checking the tenant prefix. */
export async function signedBillingUrl(key: string | null, tenantId: string, what = 'The PDF'): Promise<{ url: string }> {
  if (!key) throw conflict('PDF_NOT_READY', `${what} is being generated. Try again in a minute.`);
  assertTenantKey(key, tenantId);
  return { url: await storage.signedUrl(key, { downloadName: key.split('/').pop() }) };
}
