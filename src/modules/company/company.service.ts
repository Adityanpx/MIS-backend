import { randomUUID } from 'node:crypto';
import { exec, many, one, setClause } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import type { RequestMeta } from '../../lib/request-meta';
import { stateName } from '../../shared/indian-states';
import type { ClientCtx } from '../../types/express';
import { clientActor, diff, writeAudit } from '../audit/audit.service';
import { signedUrlOrNull, storage, tenantKey } from '../files/storage';
import type { AllowedKind } from '../files/upload';

interface CompanyRow {
  id: string; code: string; display_name: string; legal_name: string; gstin: string | null; pan: string | null;
  state_code: string; address: Record<string, unknown>; primary_contact: Record<string, unknown>; billing_emails: string[];
  logo_key: string | null; force_2fa: boolean; account_state: string; terms_version: string | null;
  terms_accepted_at: string | null; plants_count: number; users_count: number;
}
const SELECT = `
  SELECT c.id, c.code, c.display_name, c.legal_name, c.gstin, c.pan, c.state_code, c.address, c.primary_contact,
         c.billing_emails, c.logo_key, c.force_2fa, c.account_state, c.terms_version, c.terms_accepted_at,
         (SELECT count(*) FROM app.plants p WHERE p.tenant_id = c.id) AS plants_count,
         (SELECT count(*) FROM app.users u WHERE u.tenant_id = c.id AND u.status <> 'disabled') AS users_count
    FROM app.clients c WHERE c.id = $1`;

async function toDto(r: CompanyRow) {
  return {
    id: r.id, code: r.code, displayName: r.display_name, legalName: r.legal_name, gstin: r.gstin, pan: r.pan,
    stateCode: r.state_code, stateName: stateName(r.state_code), address: r.address, primaryContact: r.primary_contact,
    billingEmails: r.billing_emails, logoUrl: await signedUrlOrNull(r.logo_key), force2fa: r.force_2fa,
    accountState: r.account_state, termsVersion: r.terms_version, termsAcceptedAt: r.terms_accepted_at,
    plantsCount: r.plants_count, usersCount: r.users_count,
  };
}

/** CA-04: company profile. Legal name, GSTIN, PAN, state and address are changed only by the Super Admin (they drive invoices). */
export async function getCompany(ctx: ClientCtx) {
  return withTenant(tenantTx(ctx), async (tx) => toDto(await one<CompanyRow>(tx, SELECT, [ctx.tenantId])));
}

export async function updateCompany(
  ctx: ClientCtx,
  patch: { displayName?: string; primaryContact?: Record<string, unknown>; billingEmails?: string[] },
  meta: RequestMeta,
) {
  return withTenant(tenantTx(ctx), async (tx) => {
    const before = await one<CompanyRow>(tx, SELECT, [ctx.tenantId]);
    const set = setClause({
      display_name: patch.displayName,
      primary_contact: patch.primaryContact === undefined ? undefined : JSON.stringify(patch.primaryContact),
      billing_emails: patch.billingEmails,
    }, 2);
    if (set.values.length === 0) return toDto(before);
    await exec(tx, `UPDATE app.clients SET ${set.sql} WHERE id = $1`, [ctx.tenantId, ...set.values]);
    const after = await one<CompanyRow>(tx, SELECT, [ctx.tenantId]);
    const pick = (r: CompanyRow) => ({
      display_name: r.display_name, primary_contact: r.primary_contact, billing_emails: r.billing_emails,
    });
    await writeAudit(tx, clientActor(ctx), {
      action: 'company.update', entity: 'client', entityId: ctx.tenantId, ...diff(pick(before), pick(after)),
    }, meta);
    return toDto(after);
  });
}

export async function setCompanyLogo(
  ctx: ClientCtx, file: { ext: AllowedKind; mime: string; buffer: Buffer }, meta: RequestMeta,
) {
  const key = tenantKey(ctx.tenantId, 'branding', `logo-${randomUUID()}.${file.ext}`);
  await storage.put(key, file.buffer, file.mime);
  let oldKey: string | null = null;
  try {
    await withTenant(tenantTx(ctx), async (tx) => {
      const r = await one<{ logo_key: string | null }>(tx, 'SELECT logo_key FROM app.clients WHERE id = $1 FOR UPDATE', [ctx.tenantId]);
      oldKey = r.logo_key;
      await exec(tx, 'UPDATE app.clients SET logo_key = $2 WHERE id = $1', [ctx.tenantId, key]);
      await writeAudit(tx, clientActor(ctx), {
        action: 'company.logo_update', entity: 'client', entityId: ctx.tenantId, before: { logoKey: oldKey }, after: { logoKey: key },
      }, meta);
    });
  } catch (err) {
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
  if (oldKey) await storage.remove(oldKey).catch(() => undefined);
  return getCompany(ctx);
}

/** TRD: GET /company/audit, the tenant's own audit trail (newest first). */
export async function listAudit(
  ctx: ClientCtx,
  q: { page: number; pageSize: number; entity?: string; action?: string; from?: string; to?: string },
) {
  return withTenant(tenantTx(ctx), async (tx) => {
    const where = `a.tenant_id = $1
       AND ($2::text IS NULL OR a.entity = $2)
       AND ($3::text IS NULL OR a.action LIKE $3 || '%')
       AND ($4::date IS NULL OR a.at >= ($4::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
       AND ($5::date IS NULL OR a.at < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))`;
    const params = [ctx.tenantId, q.entity ?? null, q.action ?? null, q.from ?? null, q.to ?? null];
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.audit_log a WHERE ${where}`, params);
    const rows = await many<{
      id: number; actor_type: string; actor_id: string | null; actor_name: string | null; acting_as_admin_id: string | null;
      action: string; entity: string; entity_id: string | null; before: unknown; after: unknown; reason: string | null; at: string;
    }>(
      tx,
      `SELECT a.id, a.actor_type, a.actor_id, u.name AS actor_name, a.acting_as_admin_id, a.action, a.entity, a.entity_id,
              a.before, a.after, a.reason, a.at
         FROM app.audit_log a
         LEFT JOIN app.users u ON a.actor_type = 'user' AND u.tenant_id = a.tenant_id AND u.id = a.actor_id
        WHERE ${where} ORDER BY a.at DESC, a.id DESC LIMIT $6 OFFSET $7`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        actor: {
          type: r.actor_type,
          id: r.actor_type === 'user' ? r.actor_id : null, // platform staff identities are not exposed to clients
          name: r.actor_type === 'user' ? r.actor_name : r.actor_type === 'super_admin' ? 'Platform support' : 'System',
          viaSupportSession: !!r.acting_as_admin_id,
        },
        action: r.action, entity: r.entity, entityId: r.entity_id, before: r.before, after: r.after, reason: r.reason, at: r.at,
      })),
      total,
    };
  });
}

