import archiver from 'archiver';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec, many } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { storage, tenantKey } from '../files/storage';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import { readStoredFile } from '../exports/download';
import { generateDocs, type DocType } from './pdf.service';

registerHandler(QUEUES.pdfGenerate, async (data) => {
  const { tenantId, plantId, date, from, to, docs, reason } = data as {
    tenantId: string; plantId: string; date?: string; from?: string; to?: string; docs?: DocType[]; reason: string };
  const types: DocType[] = docs ?? ['logsheet', 'mis', 'dashboard'];
  if (date) return generateDocs(tenantId, plantId, date, types, reason);
  // bulk (PDF-02): one date after another
  for (let d = from!; d <= to!; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    await generateDocs(tenantId, plantId, d, types, reason);
  }
});

/** PDF-08: zip of the current PDFs for a date range → exports row + N-O08 notification. */
registerHandler(QUEUES.pdfZip, async (data) => {
  const { tenantId, plantId, from, to, exportId, userId } = data as { tenantId: string; plantId: string; from: string; to: string; exportId: string; userId: string };
  const ctx = { tenantId, actorId: null };
  const files = await withTenant(ctx, (tx) => many<{ file_key: string; d: string }>(tx,
    `SELECT file_key, d FROM app.pdf_documents WHERE tenant_id = $1 AND plant_id = $2 AND d BETWEEN $3 AND $4 AND status IN ('current', 'stale')
       AND file_key IS NOT NULL ORDER BY d, doc_type`, [tenantId, plantId, from, to]));
  const tmp = path.join(os.tmpdir(), `${randomUUID()}.zip`);
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const zip = archiver('zip', { zlib: { level: 6 } });
      out.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(out);
      (async () => {
        for (const f of files) zip.append(await readStoredFile(f.file_key), { name: `${f.d.slice(0, 7)}/${f.file_key.split('/').pop()}` });
        await zip.finalize();
      })().catch(reject);
    });
    const key = tenantKey(tenantId, 'exports', `${exportId}.zip`);
    await storage.put(key, await fs.promises.readFile(tmp), 'application/zip');
    const outbox = await withTenant(ctx, async (tx) => {
      await exec(tx, `UPDATE app.exports SET status = 'ready', file_key = $3, expires_at = now() + interval '7 days' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, exportId, key]);
      const to2 = (await plantRecipients(tx, tenantId, plantId, ['client_admin', 'editor', 'checker', 'verifier', 'viewer'])).filter((u) => u.id === userId);
      return notify(tx, { tenantId, to: to2, code: 'N-O08', title: `PDF zip ${from} to ${to} is ready`,
        body: `${files.length} file(s).`, link: `/exports/${exportId}`, email: true });
    });
    sendInBackground(outbox);
  } catch (err) {
    await withTenant(ctx, (tx) => exec(tx, `UPDATE app.exports SET status = 'failed', error = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, exportId, String((err as Error).message).slice(0, 300)]));
    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});
