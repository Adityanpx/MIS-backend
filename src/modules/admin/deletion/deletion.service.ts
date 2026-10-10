import { many, maybeOne } from '../../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../../db/tenant';
import { enqueue } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { conflict, notFound, unprocessable } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { adminActor, writeAudit } from '../../audit/audit.service';

/** FK-safe order. Table names come from this constant only (never from input). */
export const OPERATIONAL_TABLES = [
  'logsheet_value_history', 'logsheet_values', 'correction_requests', 'attachments', 'logsheets', 'imports', 'daily_derived',
  'pdf_documents', 'revenue_components', 'contract_years', 'parameter_standards', 'parameters', 'stock_adjustments', 'stock_items',
  'staff_strengths', 'staff_categories', 'safety_requirements', 'safety_items', 'plant_constants', 'bank_guarantees',
  'insurance_policies', 'plant_settings', 'plant_data_versions', 'exports', 'notifications', 'dashboard_layouts', 'user_plant_roles', 'refresh_tokens',
  'auth_tokens', 'users', 'client_documents', 'usage_snapshots', 'reminder_log', 'lifecycle_holds', 'act_as_sessions', 'plant_requests',
] as const;

/** DEL-01: the Super Admin confirms by typing the client code. The deletion itself runs in the client.delete job. */
export async function confirmDeletion(ctx: AdminTxCtx, clientId: string, input: { confirmCode: string; reason: string }, meta: RequestMeta) {
  await withAdmin(ctx, async (tx) => {
    const c = await maybeOne<{ code: string; status: string }>(tx, 'SELECT code, status FROM app.clients WHERE id = $1 FOR UPDATE', [clientId]);
    if (!c || c.status === 'deleted') throw notFound('Client');
    if (c.status !== 'scheduled_for_deletion') {
      throw conflict('NOT_SCHEDULED_FOR_DELETION', 'Only a terminated client past the retention period can be deleted.');
    }
    if (input.confirmCode.trim().toUpperCase() !== c.code.toUpperCase()) {
      throw unprocessable('CONFIRMATION_MISMATCH', 'Type the client code exactly to confirm.');
    }
    await writeAudit(tx, adminActor(ctx.adminId, clientId), { action: 'client.delete_confirmed', entity: 'client', entityId: clientId, reason: input.reason }, meta);
  });
  await enqueue(QUEUES.clientDelete, { tenantId: clientId, adminId: ctx.adminId });
}

export async function deletionQueue(ctx: AdminTxCtx) {
  return withAdmin(ctx, (tx) => many(tx,
    `SELECT id, code, display_name AS "displayName", terminated_at AS "terminatedAt" FROM app.clients
      WHERE status = 'scheduled_for_deletion' ORDER BY terminated_at`));
}
