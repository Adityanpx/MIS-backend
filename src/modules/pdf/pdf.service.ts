import { env } from '../../config/env';
import { exec, many, maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { formatDisplayDate } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { readStoredFile } from '../exports/download';
import { buildDashboard } from '../engine/core/dashboard';
import { buildMis } from '../engine/core/mis';
import { getBundle } from '../engine/engine.service';
import { signedUrlOrNull, storage, tenantKey } from '../files/storage';
import { platformName } from '../platform/settings.service';
import type { ReportTable } from '../reports/table';
import { renderPdf } from './browser';
import { dashboardHtml } from './templates/dashboard';
import { logsheetHtml } from './templates/logsheet';
import { misHtml, type MisFilter } from './templates/mis';
import { tableHtml } from './templates/table';

export type DocType = 'logsheet' | 'mis' | 'dashboard';
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** PDF-03 key: t/{tenant}/p/{plant}/pdf/YYYY/MMM-YYYY/DD-MMM-YYYY/{DOC} DD-MMM-YYYY v{n}.pdf */
export function pdfKey(tenantId: string, plantId: string, d: string, title: string, version: number): string {
  const disp = formatDisplayDate(d).toUpperCase();
  const y = d.slice(0, 4);
  const mmm = `${MON[Number(d.slice(5, 7)) - 1]}-${y}`;
  return tenantKey(tenantId, 'p', plantId, 'pdf', y, mmm, disp, `${title} ${disp} v${version}.pdf`);
}
export const docTitle = (doc: DocType, misPrefix: string) =>
  doc === 'logsheet' ? 'DAILY LOGSHEET' : doc === 'mis' ? misPrefix : 'MIS DASHBOARD';

/** Builds the HTML for one document (no browser; also used by tests). */
export async function documentHtml(
  tenantId: string, plantId: string, d: string, doc: DocType, version: number, filter?: MisFilter,
): Promise<string> {
  const b = await getBundle(tenantId, plantId);
  const logoKey = await withTenant({ tenantId, actorId: null }, async (tx) =>
    (await one<{ logo_key: string | null }>(tx, 'SELECT logo_key FROM app.clients WHERE id = $1', [tenantId])).logo_key);
  const meta = { version, platform: await platformName(), generatedAt: new Date().toISOString(), logoUrl: await signedUrlOrNull(logoKey) };
  // archived (auto) MIS: Daily · the plant's primary standard; the MIS page's Download passes the user's own filter
  if (doc === 'mis') return misHtml(buildMis(b, d, { generatedAt: meta.generatedAt }, filter?.from), meta, filter ?? { period: 'today', kind: b.settings.primaryStandard });
  if (doc === 'dashboard') return dashboardHtml(buildDashboard(b, d), meta);
  return logsheetHtml(b, d, meta);
}

/** PDF-01/04: generate new versions; the previous current version becomes superseded. Never throws for one bad doc. */
export async function generateDocs(tenantId: string, plantId: string, d: string, docs: DocType[], reason: string): Promise<void> {
  if (!env.PDF_ENABLED) {
    logger.info({ tenantId, plantId, d, docs }, 'PDF generation disabled (PDF_ENABLED=false)');
    return;
  }
  const b = await getBundle(tenantId, plantId);
  for (const doc of docs) {
    const version = await withTenant({ tenantId, actorId: null }, async (tx) =>
      ((await maybeOne<{ v: number | null }>(tx,
        'SELECT max(version) AS v FROM app.pdf_documents WHERE tenant_id = $1 AND plant_id = $2 AND d = $3 AND doc_type = $4',
        [tenantId, plantId, d, doc]))?.v ?? 0) + 1);
    try {
      const html = await documentHtml(tenantId, plantId, d, doc, version);
      const pdf = await renderPdf(html, doc === 'mis' ? { format: 'A4', landscape: true } : doc === 'dashboard'
        ? { format: 'A3', landscape: false } : { format: 'A4', landscape: false });
      const key = pdfKey(tenantId, plantId, d, docTitle(doc, b.settings.display.pdfPrefixMis), version);
      await storage.put(key, pdf, 'application/pdf');
      await withTenant({ tenantId, actorId: null }, async (tx) => {
        await exec(tx, `UPDATE app.pdf_documents SET status = 'superseded', reason = $5
            WHERE tenant_id = $1 AND plant_id = $2 AND d = $3 AND doc_type = $4 AND status IN ('current', 'stale', 'failed')`,
          [tenantId, plantId, d, doc, reason]);
        await exec(tx, `INSERT INTO app.pdf_documents (tenant_id, plant_id, d, doc_type, version, file_key, size_bytes, status, reason, data_version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'current', $8, $9)`,
          [tenantId, plantId, d, doc, version, key, pdf.length, reason, b.dataVersion]);
      });
    } catch (err) {
      logger.error({ err, tenantId, plantId, d, doc }, 'PDF generation failed');
      await withTenant({ tenantId, actorId: null }, (tx) => exec(tx,
        `INSERT INTO app.pdf_documents (tenant_id, plant_id, d, doc_type, version, status, reason, data_version)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7)`, [tenantId, plantId, d, doc, version, String((err as Error).message).slice(0, 300), b.dataVersion]));
      throw err; // the job retries (3 times)
    }
  }
}

/** Newest current/stale version of a document whose file can really be read from storage (null if none). */
async function readableVersion(tenantId: string, plantId: string, d: string, doc: DocType): Promise<{ key: string; file: Buffer } | null> {
  const rows = await withTenant({ tenantId, actorId: null }, (tx) => many<{ file_key: string }>(tx,
    `SELECT file_key FROM app.pdf_documents
      WHERE tenant_id = $1 AND plant_id = $2 AND d = $3 AND doc_type = $4 AND status IN ('current', 'stale') AND file_key IS NOT NULL
      ORDER BY version DESC LIMIT 3`, [tenantId, plantId, d, doc]));
  for (const r of rows) {
    try {
      return { key: r.file_key, file: await readStoredFile(r.file_key) };
    } catch (err) {
      logger.warn({ err, key: r.file_key }, 'Archived PDF file is missing in storage');
    }
  }
  return null;
}

/**
 * Download path: always returns PDF bytes. Uses the archived file when it exists; when the record points to a file that
 * is no longer in storage (or there is no record), a fresh version is generated first, so a click never ends in an error.
 */
export async function pdfForDownload(tenantId: string, plantId: string, d: string, doc: DocType): Promise<{ key: string; file: Buffer }> {
  const found = await readableVersion(tenantId, plantId, d, doc);
  if (found) return found;
  if (!env.PDF_ENABLED) throw badRequest('PDF_DISABLED', 'PDF generation is turned off.');
  try {
    await generateDocs(tenantId, plantId, d, [doc], 'regenerate');
  } catch (err) {
    const again = await readableVersion(tenantId, plantId, d, doc); // a parallel click may have generated it
    if (again) return again;
    throw err;
  }
  const made = await readableVersion(tenantId, plantId, d, doc);
  if (!made) throw badRequest('PDF_UNAVAILABLE', 'The PDF could not be prepared. Please try again.');
  return made;
}

const PERIOD_FILE: Record<MisFilter['period'], string> = { today: 'DAILY', mtd: 'MONTHLY', utd: 'UTD', range: 'RANGE', all: 'ALL' };

/** MIS PDF for exactly the filter on screen (Daily / Monthly / UTD × Actual / Bidding). Built fresh on every click, never archived. */
export async function misFilteredPdf(tenantId: string, plantId: string, d: string, filter: MisFilter): Promise<{ key: string; file: Buffer }> {
  if (!env.PDF_ENABLED) throw badRequest('PDF_DISABLED', 'PDF generation is turned off.');
  const b = await getBundle(tenantId, plantId);
  const file = await renderPdf(await documentHtml(tenantId, plantId, d, 'mis', 1, filter), { format: 'A4', landscape: true });
  const disp = (filter.from && filter.from < d ? `${formatDisplayDate(filter.from)} TO ${formatDisplayDate(d)}` : formatDisplayDate(d)).toUpperCase();
  const name = `${docTitle('mis', b.settings.display.pdfPrefixMis)} ${disp} ${PERIOD_FILE[filter.period]} ${filter.kind.toUpperCase()}.pdf`;
  return { key: tenantKey(tenantId, 'p', plantId, 'pdf', name), file };
}

export async function tablePdf(t: ReportTable): Promise<Buffer> {
  return renderPdf(tableHtml(t), { format: 'A4', landscape: true });
}
