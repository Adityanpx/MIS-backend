import { randomUUID } from 'node:crypto';
import { exec, many, maybeOne, one } from '../../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../../db/tenant';
import { notFound } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { assertTenantKey, storage, tenantKey } from '../../files/storage';
import { loadClient } from './clients.service';

const COLS = `id, doc_type AS "docType", title, doc_date AS "docDate", remarks, created_at AS "createdAt"`;

export async function listDocuments(ctx: AdminTxCtx, clientId: string) {
  return withAdmin(ctx, async (tx) => {
    await loadClient(tx, clientId);
    return many(tx, `SELECT ${COLS} FROM app.client_documents WHERE tenant_id = $1 ORDER BY created_at DESC`, [clientId]);
  });
}
export async function addDocument(
  ctx: AdminTxCtx, clientId: string, fields: { docType: string; title: string; docDate?: string; remarks?: string },
  file: { ext: string; mime: string; buffer: Buffer }, meta: RequestMeta,
) {
  await withAdmin(ctx, (tx) => loadClient(tx, clientId));
  const key = tenantKey(clientId, 'documents', `${randomUUID()}.${file.ext}`);
  await storage.put(key, file.buffer, file.mime);
  try {
    return await withAdmin(ctx, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO app.client_documents (tenant_id, doc_type, title, file_key, doc_date, remarks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
        [clientId, fields.docType, fields.title, key, fields.docDate ?? null, fields.remarks ?? null, ctx.adminId],
      );
      await writeAudit(tx, adminActor(ctx.adminId, clientId), { action: 'client.document_add', entity: 'client_document', entityId: String(row.id), after: fields }, meta);
      return row;
    });
  } catch (err) {
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}
async function loadDoc(ctx: AdminTxCtx, clientId: string, docId: string) {
  const d = await withAdmin(ctx, (tx) => maybeOne<{ file_key: string }>(
    tx, 'SELECT file_key FROM app.client_documents WHERE tenant_id = $1 AND id = $2', [clientId, docId]));
  if (!d) throw notFound('Document');
  assertTenantKey(d.file_key, clientId);
  return d;
}
export async function documentUrl(ctx: AdminTxCtx, clientId: string, docId: string) {
  const d = await loadDoc(ctx, clientId, docId);
  return { url: await storage.signedUrl(d.file_key, { downloadName: d.file_key.split('/').pop() }) };
}
export async function deleteDocument(ctx: AdminTxCtx, clientId: string, docId: string, meta: RequestMeta) {
  const d = await loadDoc(ctx, clientId, docId);
  await withAdmin(ctx, async (tx) => {
    await exec(tx, 'DELETE FROM app.client_documents WHERE tenant_id = $1 AND id = $2', [clientId, docId]);
    await writeAudit(tx, adminActor(ctx.adminId, clientId), { action: 'client.document_delete', entity: 'client_document', entityId: docId }, meta);
  });
  await storage.remove(d.file_key).catch(() => undefined);
}
