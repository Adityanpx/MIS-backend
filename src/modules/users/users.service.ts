import { exec, many, maybeOne, one, setClause } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import type { RequestMeta } from '../../lib/request-meta';
import type { PlantRole } from '../../shared/enums';
import { diff, writeAudit, type AuditActor } from '../audit/audit.service';
import { revokeAllRefreshTokens } from '../auth/auth.repo';
import { createUserToken, queueClientInviteEmail, queueClientResetEmail } from '../auth/user-tokens';
import { assertManagementUserLimits, assertPlantUserLimits } from '../domain/plan-limits';

export interface PlantRoleInput {
  plantId: string;
  role: PlantRole;
}
export interface UserDto {
  id: string; name: string; email: string; mobile: string | null; designation: string | null;
  isClientAdmin: boolean; isManagement: boolean; status: string; totpEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  plantRoles: Array<{ plantId: string; plantName: string; role: PlantRole }>;
}
interface UserRowWithRoles {
  id: string; name: string; email: string; mobile: string | null; designation: string | null;
  is_client_admin: boolean; is_management: boolean; status: string; totp_enabled: boolean; last_login_at: string | null; created_at: string;
  plant_roles: Array<{ plantId: string; plantName: string; role: PlantRole }>;
}

const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.mobile, u.designation, u.is_client_admin, u.is_management, u.status, u.totp_enabled,
         u.last_login_at, u.created_at,
         coalesce((SELECT json_agg(json_build_object('plantId', r.plant_id, 'plantName', p.name, 'role', r.role) ORDER BY p.name)
                     FROM app.user_plant_roles r
                     JOIN app.plants p ON p.tenant_id = r.tenant_id AND p.id = r.plant_id
                    WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id), '[]'::json) AS plant_roles
    FROM app.users u`;

const toDto = (r: UserRowWithRoles): UserDto => ({
  id: r.id, name: r.name, email: r.email, mobile: r.mobile, designation: r.designation,
  isClientAdmin: r.is_client_admin, isManagement: r.is_management, status: r.status, totpEnabled: r.totp_enabled,
  lastLoginAt: r.last_login_at, createdAt: r.created_at, plantRoles: r.plant_roles,
});

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listUsers(
  tx: Tx,
  tenantId: string,
  q: { page: number; pageSize: number; q?: string; status?: string },
): Promise<{ items: UserDto[]; total: number }> {
  const where = `u.tenant_id = $1
     AND ($2::text IS NULL OR u.name ILIKE $2 OR u.email ILIKE $2)
     AND ($3::text IS NULL OR u.status = $3)`;
  const params = [tenantId, q.q ? likePattern(q.q) : null, q.status ?? null];
  const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.users u WHERE ${where}`, params);
  const rows = await many<UserRowWithRoles>(
    tx,
    `${USER_SELECT} WHERE ${where} ORDER BY u.is_client_admin DESC, u.name ASC LIMIT $4 OFFSET $5`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { items: rows.map(toDto), total };
}

export async function getUser(tx: Tx, tenantId: string, userId: string): Promise<UserDto> {
  const row = await maybeOne<UserRowWithRoles>(tx, `${USER_SELECT} WHERE u.tenant_id = $1 AND u.id = $2`, [tenantId, userId]);
  if (!row) throw notFound('User');
  return toDto(row);
}

function assertNoDuplicatePlants(roles: PlantRoleInput[]): void {
  if (new Set(roles.map((r) => r.plantId)).size !== roles.length) {
    throw badRequest('DUPLICATE_PLANT', 'A plant appears more than once.');
  }
}
/** A plant ID that is not in this tenant behaves exactly like a missing plant (404). */
async function assertPlantsInTenant(tx: Tx, tenantId: string, plantIds: string[]): Promise<void> {
  if (plantIds.length === 0) return;
  const found = await many<{ id: string }>(
    tx, 'SELECT id FROM app.plants WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, plantIds]);
  if (found.length !== new Set(plantIds).size) throw notFound('Plant');
}
/** CA-08: at least one active Client Admin must remain. */
async function assertAnotherActiveAdmin(tx: Tx, tenantId: string, userId: string): Promise<void> {
  const { n } = await one<{ n: number }>(
    tx,
    `SELECT count(*) AS n FROM app.users
      WHERE tenant_id = $1 AND id <> $2 AND is_client_admin AND status = 'active'`,
    [tenantId, userId],
  );
  if (n === 0) throw conflict('LAST_CLIENT_ADMIN', 'At least one active Client Admin must remain.');
}
async function lockUser(tx: Tx, tenantId: string, userId: string) {
  const u = await maybeOne<{
    id: string; name: string; email: string; mobile: string | null; designation: string | null;
    is_client_admin: boolean; is_management: boolean; status: string; password_hash: string | null;
  }>(
    tx,
    `SELECT id, name, email, mobile, designation, is_client_admin, is_management, status, password_hash
       FROM app.users WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, userId],
  );
  if (!u) throw notFound('User');
  return u;
}
const plantIdsOf = async (tx: Tx, tenantId: string, userId: string) =>
  (await many<{ plant_id: string }>(
    tx, 'SELECT plant_id FROM app.user_plant_roles WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId],
  )).map((r) => r.plant_id);

export interface InviteInput {
  name: string; email: string; mobile?: string; designation?: string; isClientAdmin: boolean; isManagement?: boolean;
  plantRoles: PlantRoleInput[];
}

/** CA-05: create an invited user (+ plant roles) and queue the invitation email. Catch EMAIL_IN_USE outside the tx. */
export async function inviteUser(
  tx: Tx,
  tenantId: string,
  input: InviteInput,
  actor: AuditActor,
  meta: RequestMeta,
): Promise<{ user: UserDto; outboxId: string | null }> {
  const isManagement = !!input.isManagement;
  const roles = input.isClientAdmin || isManagement ? [] : input.plantRoles;
  assertNoDuplicatePlants(roles);
  await assertPlantsInTenant(tx, tenantId, roles.map((r) => r.plantId));
  await assertPlantUserLimits(tx, tenantId, null, roles.map((r) => r.plantId));
  if (isManagement) await assertManagementUserLimits(tx, tenantId, null);
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.users (tenant_id, name, email, mobile, designation, is_client_admin, is_management, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'invited', $8) RETURNING id`,
    [tenantId, input.name, input.email, input.mobile ?? null, input.designation ?? null, input.isClientAdmin, isManagement, actor.actorId],
  );
  for (const r of roles) {
    await exec(
      tx,
      'INSERT INTO app.user_plant_roles (tenant_id, user_id, plant_id, role, created_by) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, id, r.plantId, r.role, actor.actorId],
    );
  }
  const raw = await createUserToken(tx, tenantId, id, 'invite');
  const { display_name } = await one<{ display_name: string }>(tx, 'SELECT display_name FROM app.clients WHERE id = $1', [tenantId]);
  const outboxId = await queueClientInviteEmail(tx, tenantId, input, raw, display_name);
  const user = await getUser(tx, tenantId, id);
  await writeAudit(tx, actor, { action: 'user.invite', entity: 'user', entityId: id, after: user }, meta);
  return { user, outboxId };
}

/** First Client Admin of a new client: active immediately with the password set by the Super Admin. No token, no email. */
export async function createActiveClientAdmin(
  tx: Tx,
  tenantId: string,
  input: { name: string; email: string; mobile?: string; passwordHash: string },
  actor: AuditActor,
  meta: RequestMeta,
): Promise<UserDto> {
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.users (tenant_id, name, email, mobile, is_client_admin, status, password_hash, created_by)
     VALUES ($1, $2, $3, $4, true, 'active', $5, $6) RETURNING id`,
    [tenantId, input.name, input.email, input.mobile ?? null, input.passwordHash, actor.actorId],
  );
  const user = await getUser(tx, tenantId, id);
  await writeAudit(tx, actor, { action: 'user.create', entity: 'user', entityId: id, after: user }, meta);
  return user;
}

export async function updateUser(
  tx: Tx,
  tenantId: string,
  userId: string,
  patch: { name?: string; mobile?: string | null; designation?: string | null; isClientAdmin?: boolean; isManagement?: boolean },
  actor: AuditActor,
  meta: RequestMeta,
): Promise<UserDto> {
  const before = await lockUser(tx, tenantId, userId);
  const willBeManagement = patch.isManagement ?? before.is_management;
  const willBeClientAdmin = patch.isClientAdmin ?? before.is_client_admin;
  if (willBeClientAdmin && willBeManagement) {
    throw unprocessable('CLIENT_ADMIN_HAS_ALL_PLANTS', 'A Client Admin cannot also be a Management user.');
  }
  if (patch.isClientAdmin === false && before.is_client_admin) {
    await assertAnotherActiveAdmin(tx, tenantId, userId);
    // From now on the user counts against each plant's user limit again.
    if (before.status !== 'disabled') await assertPlantUserLimits(tx, tenantId, userId, await plantIdsOf(tx, tenantId, userId));
  }
  if (patch.isManagement === true && !before.is_management) {
    if (before.status !== 'disabled') await assertManagementUserLimits(tx, tenantId, userId);
    // A Management user is company-wide read-only: it never keeps per-plant roles.
    await exec(tx, 'DELETE FROM app.user_plant_roles WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
  }
  const set = setClause(
    {
      name: patch.name, mobile: patch.mobile, designation: patch.designation,
      is_client_admin: patch.isClientAdmin, is_management: patch.isManagement,
    }, 3);
  if (set.values.length > 0) {
    const after = await one<Record<string, unknown>>(
      tx,
      `UPDATE app.users SET ${set.sql} WHERE tenant_id = $1 AND id = $2
       RETURNING name, mobile, designation, is_client_admin, is_management`,
      [tenantId, userId, ...set.values],
    );
    const b = {
      name: before.name, mobile: before.mobile, designation: before.designation,
      is_client_admin: before.is_client_admin, is_management: before.is_management,
    };
    await writeAudit(tx, actor, { action: 'user.update', entity: 'user', entityId: userId, ...diff(b, after) }, meta);
  }
  return getUser(tx, tenantId, userId);
}

export async function setUserStatus(
  tx: Tx,
  tenantId: string,
  userId: string,
  action: 'disable' | 'enable',
  actor: AuditActor,
  meta: RequestMeta,
  selfUserId?: string,
): Promise<UserDto> {
  const u = await lockUser(tx, tenantId, userId);
  if (action === 'disable') {
    if (selfUserId === userId) throw conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
    if (u.status === 'disabled') return getUser(tx, tenantId, userId);
    if (u.is_client_admin) await assertAnotherActiveAdmin(tx, tenantId, userId);
    await exec(
      tx,
      `UPDATE app.users SET status = 'disabled', token_version = token_version + 1 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId],
    );
    await revokeAllRefreshTokens(tx, tenantId, userId);
  } else {
    if (u.status !== 'disabled') return getUser(tx, tenantId, userId);
    if (u.is_management) await assertManagementUserLimits(tx, tenantId, userId);
    else if (!u.is_client_admin) await assertPlantUserLimits(tx, tenantId, userId, await plantIdsOf(tx, tenantId, userId));
    await exec(tx, 'UPDATE app.users SET status = $3 WHERE tenant_id = $1 AND id = $2', [
      tenantId, userId, u.password_hash ? 'active' : 'invited',
    ]);
  }
  await writeAudit(tx, actor, { action: `user.${action}`, entity: 'user', entityId: userId }, meta);
  return getUser(tx, tenantId, userId);
}

/** CA-07: new invitation link (older links stop working). */
export async function resendInvite(
  tx: Tx, tenantId: string, userId: string, actor: AuditActor, meta: RequestMeta,
): Promise<string | null> {
  const u = await lockUser(tx, tenantId, userId);
  if (u.status !== 'invited') throw conflict('USER_NOT_INVITED', 'This user has already accepted the invitation.');
  const raw = await createUserToken(tx, tenantId, userId, 'invite');
  const { display_name } = await one<{ display_name: string }>(tx, 'SELECT display_name FROM app.clients WHERE id = $1', [tenantId]);
  await writeAudit(tx, actor, { action: 'user.invite_resent', entity: 'user', entityId: userId }, meta);
  return queueClientInviteEmail(tx, tenantId, u, raw, display_name);
}

/** CA-07: send a password-reset link to the user. */
export async function sendPasswordReset(
  tx: Tx, tenantId: string, userId: string, actor: AuditActor, meta: RequestMeta,
): Promise<string | null> {
  const u = await lockUser(tx, tenantId, userId);
  if (u.status !== 'active') throw conflict('USER_NOT_ACTIVE', 'Only active users can reset their password.');
  const raw = await createUserToken(tx, tenantId, userId, 'reset');
  await writeAudit(tx, actor, { action: 'user.password_reset_sent', entity: 'user', entityId: userId }, meta);
  return queueClientResetEmail(tx, tenantId, u, raw);
}

/** CA-05/06: replace the complete set of plant roles of a (non-admin) user. */
export async function setPlantRoles(
  tx: Tx,
  tenantId: string,
  userId: string,
  roles: PlantRoleInput[],
  actor: AuditActor,
  meta: RequestMeta,
): Promise<UserDto> {
  const u = await lockUser(tx, tenantId, userId);
  if (u.is_client_admin) {
    throw unprocessable('CLIENT_ADMIN_HAS_ALL_PLANTS', 'A Client Admin already has access to every plant.');
  }
  if (u.is_management) {
    throw unprocessable('MANAGEMENT_HAS_NO_PLANT_ROLES', 'A Management user does not take per-plant roles.');
  }
  assertNoDuplicatePlants(roles);
  await assertPlantsInTenant(tx, tenantId, roles.map((r) => r.plantId));
  const before = await getUser(tx, tenantId, userId);
  const current = new Set(before.plantRoles.map((r) => r.plantId));
  const added = roles.map((r) => r.plantId).filter((id) => !current.has(id));
  if (u.status !== 'disabled') await assertPlantUserLimits(tx, tenantId, userId, added);
  await exec(
    tx,
    'DELETE FROM app.user_plant_roles WHERE tenant_id = $1 AND user_id = $2 AND NOT (plant_id = ANY($3::uuid[]))',
    [tenantId, userId, roles.map((r) => r.plantId)],
  );
  for (const r of roles) {
    await exec(
      tx,
      `INSERT INTO app.user_plant_roles (tenant_id, user_id, plant_id, role, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id, plant_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, userId, r.plantId, r.role, actor.actorId],
    );
  }
  const after = await getUser(tx, tenantId, userId);
  await writeAudit(tx, actor, {
    action: 'user.plant_roles_set', entity: 'user', entityId: userId,
    before: before.plantRoles, after: after.plantRoles,
  }, meta);
  return after;
}
