import { randomUUID } from 'node:crypto';
import { exec, many, maybeOne, one, setClause } from '../../../db/sql';
import { isUniqueViolation } from '../../../db/errors';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import { conflict, notFound, unprocessable } from '../../../lib/errors';
import { orderBy } from '../../../lib/pagination';
import type { RequestMeta } from '../../../lib/request-meta';
import { stateName } from '../../../shared/indian-states';
import { adminActor, diff, writeAudit } from '../../audit/audit.service';
import { signedUrlOrNull, storage, tenantKey } from '../../files/storage';
import type { AllowedKind } from '../../files/upload';
import { assertPasswordPolicy, hashPassword } from '../../../lib/password';
import { createActiveClientAdmin } from '../../users/users.service';

interface ClientRowFull {
  id: string; code: string; display_name: string; legal_name: string; gstin: string | null; pan: string | null;
  state_code: string; address: Record<string, unknown>; primary_contact: Record<string, unknown>; billing_emails: string[];
  logo_key: string | null; notes: string | null; force_2fa: boolean; account_state: string; manual_suspended: boolean;
  hold_until: string | null; status: string; terms_version: string | null; terms_accepted_at: string | null;
  created_at: string; plants_count: number; users_count: number;
}
const SELECT = `
  SELECT c.id, c.code, c.display_name, c.legal_name, c.gstin, c.pan, c.state_code, c.address, c.primary_contact,
         c.billing_emails, c.logo_key, c.notes, c.force_2fa, c.account_state, c.manual_suspended, c.hold_until,
         c.status, c.terms_version, c.terms_accepted_at, c.created_at,
         (SELECT count(*) FROM app.plants p WHERE p.tenant_id = c.id) AS plants_count,
         (SELECT count(*) FROM app.users u WHERE u.tenant_id = c.id AND u.status <> 'disabled') AS users_count
    FROM app.clients c`;

async function toDto(r: ClientRowFull) {
  return {
    id: r.id, code: r.code, displayName: r.display_name, legalName: r.legal_name, gstin: r.gstin, pan: r.pan,
    stateCode: r.state_code, stateName: stateName(r.state_code), address: r.address, primaryContact: r.primary_contact,
    billingEmails: r.billing_emails, logoUrl: await signedUrlOrNull(r.logo_key), notes: r.notes, force2fa: r.force_2fa,
    accountState: r.account_state, manualSuspended: r.manual_suspended, holdUntil: r.hold_until, status: r.status,
    termsVersion: r.terms_version, termsAcceptedAt: r.terms_accepted_at, createdAt: r.created_at,
    plantsCount: r.plants_count, usersCount: r.users_count,
  };
}
export type ClientDto = Awaited<ReturnType<typeof toDto>>;

/** 404 for unknown or deleted clients. Use at the start of every /clients/:id/... operation. */
export async function loadClient(tx: Tx, id: string, forUpdate = false): Promise<ClientRowFull> {
  if (forUpdate) await tx.query('SELECT 1 FROM app.clients WHERE id = $1 FOR UPDATE', [id]);
  const r = await maybeOne<ClientRowFull>(tx, `${SELECT} WHERE c.id = $1 AND c.status <> 'deleted'`, [id]);
  if (!r) throw notFound('Client');
  return r;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listClients(
  ctx: AdminTxCtx,
  q: { page: number; pageSize: number; q?: string; sort?: string; stateCode?: string; accountState?: string },
) {
  return withAdmin(ctx, async (tx) => {
    const where = `c.status <> 'deleted'
       AND ($1::text IS NULL OR c.display_name ILIKE $1 OR c.legal_name ILIKE $1 OR c.code ILIKE $1 OR c.gstin ILIKE $1)
       AND ($2::text IS NULL OR c.state_code = $2)
       AND ($3::text IS NULL OR c.account_state = $3)`;
    const params = [q.q ? likePattern(q.q) : null, q.stateCode ?? null, q.accountState ?? null];
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.clients c WHERE ${where}`, params);
    const sort = orderBy(q.sort, { name: 'c.display_name', code: 'c.code', createdAt: 'c.created_at', state: 'c.state_code' },
      'c.created_at DESC');
    const rows = await many<ClientRowFull>(tx, `${SELECT} WHERE ${where} ORDER BY ${sort} LIMIT $4 OFFSET $5`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items: await Promise.all(rows.map(toDto)), total };
  });
}

export async function getClient(ctx: AdminTxCtx, id: string): Promise<ClientDto> {
  return withAdmin(ctx, async (tx) => toDto(await loadClient(tx, id)));
}

async function nextClientCode(tx: Tx): Promise<string> {
  const { n } = await one<{ n: number }>(
    tx, `SELECT coalesce(max(substring(code from 4)::int), 0) + 1 AS n FROM app.clients WHERE code ~ '^CL-[0-9]+$'`);
  return `CL-${String(n).padStart(4, '0')}`;
}

export interface ClientCreateInput {
  displayName: string; legalName: string; gstin?: string; pan?: string; stateCode: string;
  address: Record<string, unknown>; primaryContact: Record<string, unknown>; billingEmails: string[];
  notes?: string; force2fa?: boolean; code?: string;
  firstAdmin: { name: string; email: string; mobile?: string; password: string };
}

/** CL-01/02: client + first Client Admin (active, password set by the Super Admin) in ONE transaction. No e-mail is sent. */
export async function createClient(ctx: AdminTxCtx, input: ClientCreateInput, meta: RequestMeta): Promise<ClientDto> {
  assertPasswordPolicy(input.firstAdmin.password);
  const passwordHash = await hashPassword(input.firstAdmin.password);
  try {
    const { id } = await withAdmin(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ommis:client-code']);
      if (input.code) {
        const taken = await maybeOne(tx, 'SELECT 1 FROM app.clients WHERE code = $1', [input.code]);
        if (taken) throw conflict('CODE_TAKEN', 'This client code is already used.');
      }
      const code = input.code ?? (await nextClientCode(tx));
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO app.clients (code, display_name, legal_name, gstin, pan, state_code, address, primary_contact,
                                  billing_emails, notes, force_2fa, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12) RETURNING id`,
        [code, input.displayName, input.legalName, input.gstin ?? null, input.pan ?? null, input.stateCode,
          JSON.stringify(input.address), JSON.stringify(input.primaryContact), input.billingEmails,
          input.notes ?? null, input.force2fa ?? false, ctx.adminId],
      );
      const actor = adminActor(ctx.adminId, row.id);
      await writeAudit(tx, actor, {
        action: 'client.create', entity: 'client', entityId: row.id, after: { ...input, code, firstAdmin: undefined },
      }, meta);
      const { password: _plain, ...admin } = input.firstAdmin;
      await createActiveClientAdmin(tx, row.id, { ...admin, passwordHash }, actor, meta);
      return { id: row.id };
    });
    return getClient(ctx, id);
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_uq')) {
      throw conflict('EMAIL_IN_USE', "The first admin's email address is already registered.");
    }
    if (isUniqueViolation(err, 'clients_code_key')) throw conflict('CODE_TAKEN', 'This client code is already used.');
    throw err;
  }
}

/** CL-06: edit any field. Old invoices never change (they hold their own buyer snapshot, Phase 3). */
export async function updateClient(
  ctx: AdminTxCtx,
  id: string,
  patch: {
    displayName?: string; legalName?: string; gstin?: string | null; pan?: string | null; stateCode?: string;
    address?: Record<string, unknown>; primaryContact?: Record<string, unknown>; billingEmails?: string[];
    notes?: string | null; force2fa?: boolean;
  },
  meta: RequestMeta,
): Promise<ClientDto> {
  return withAdmin(ctx, async (tx) => {
    const before = await loadClient(tx, id, true);
    const gstin = patch.gstin !== undefined ? patch.gstin : before.gstin;
    const state = patch.stateCode ?? before.state_code;
    if (gstin && gstin.slice(0, 2) !== state) {
      throw unprocessable('GSTIN_STATE_MISMATCH', 'GSTIN state code must match the selected state.', { field: 'gstin' });
    }
    const set = setClause({
      display_name: patch.displayName, legal_name: patch.legalName, gstin: patch.gstin, pan: patch.pan,
      state_code: patch.stateCode,
      address: patch.address === undefined ? undefined : JSON.stringify(patch.address),
      primary_contact: patch.primaryContact === undefined ? undefined : JSON.stringify(patch.primaryContact),
      billing_emails: patch.billingEmails, notes: patch.notes, force_2fa: patch.force2fa,
    }, 2);
    if (set.values.length === 0) return toDto(before);
    await exec(tx, `UPDATE app.clients SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
    const after = await loadClient(tx, id);
    const pick = (r: ClientRowFull) => ({
      display_name: r.display_name, legal_name: r.legal_name, gstin: r.gstin, pan: r.pan, state_code: r.state_code,
      address: r.address, primary_contact: r.primary_contact, billing_emails: r.billing_emails, notes: r.notes,
      force_2fa: r.force_2fa,
    });
    await writeAudit(tx, adminActor(ctx.adminId, id), {
      action: 'client.update', entity: 'client', entityId: id, ...diff(pick(before), pick(after)),
    }, meta);
    return toDto(after);
  });
}

/** CL-01 logo (PNG/JPG/SVG ≤ 1 MB). The file is stored first; the old file is removed only after commit. */
export async function setClientLogo(
  ctx: AdminTxCtx, id: string, file: { ext: AllowedKind; mime: string; buffer: Buffer }, meta: RequestMeta,
): Promise<ClientDto> {
  await withAdmin(ctx, (tx) => loadClient(tx, id));
  const key = tenantKey(id, 'branding', `logo-${randomUUID()}.${file.ext}`);
  await storage.put(key, file.buffer, file.mime);
  let oldKey: string | null = null;
  try {
    await withAdmin(ctx, async (tx) => {
      const before = await loadClient(tx, id, true);
      oldKey = before.logo_key;
      await exec(tx, 'UPDATE app.clients SET logo_key = $2 WHERE id = $1', [id, key]);
      await writeAudit(tx, adminActor(ctx.adminId, id), {
        action: 'client.logo_update', entity: 'client', entityId: id, before: { logoKey: oldKey }, after: { logoKey: key },
      }, meta);
    });
  } catch (err) {
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
  if (oldKey) await storage.remove(oldKey).catch(() => undefined);
  return getClient(ctx, id);
}
