import { many, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { unprocessable } from '../../lib/errors';
import { DEFAULT_MAX_MANAGEMENT_USERS, DEFAULT_MAX_USERS_PER_PLANT } from '../../shared/constants';

/** Max users for each plant (from the current subscription's snapshot, default 10 when none). */
export async function plantUserUsage(
  tx: Tx,
  tenantId: string,
  plantIds: string[],
  excludeUserId: string | null,
): Promise<Array<{ plant_id: string; plant_name: string; used: number; max_users: number }>> {
  if (plantIds.length === 0) return [];
  const rows = await many<{ plant_id: string; plant_name: string; used: number; max_users: number | null }>(
    tx,
    `SELECT p.id AS plant_id, p.name AS plant_name,
            (SELECT count(*) FROM app.user_plant_roles r
               JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
              WHERE r.tenant_id = p.tenant_id AND r.plant_id = p.id
                AND u.status IN ('active', 'invited') AND NOT u.is_client_admin
                AND ($3::uuid IS NULL OR u.id <> $3::uuid)) AS used,
            (SELECT (s.plan_snapshot->>'maxUsersPerPlant')::int FROM app.subscriptions s
              WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id AND s.status IN ('active', 'scheduled')
              ORDER BY (s.status = 'active') DESC, s.start_date ASC LIMIT 1) AS max_users
       FROM app.plants p
      WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
    [tenantId, plantIds, excludeUserId],
  );
  return rows.map((r) => ({ ...r, max_users: r.max_users ?? DEFAULT_MAX_USERS_PER_PLANT }));
}

/** Throws USER_LIMIT_REACHED if giving `userId` access to `newPlantIds` would exceed any plant's limit. */
export async function assertPlantUserLimits(
  tx: Tx,
  tenantId: string,
  userId: string | null,
  newPlantIds: string[],
): Promise<void> {
  const ids = [...new Set(newPlantIds)].sort(); // sorted → locks always taken in the same order (no deadlocks)
  for (const id of ids) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`plant-users:${id}`]);
  }
  for (const r of await plantUserUsage(tx, tenantId, ids, userId)) {
    if (r.used + 1 > r.max_users) {
      throw unprocessable(
        'USER_LIMIT_REACHED',
        `User limit reached for ${r.plant_name} – contact your provider to upgrade.`,
        { plantId: r.plant_id, limit: r.max_users },
      );
    }
  }
}

/** v1.1 (GR-17/MGT): tenant-wide cap on Management users — the tightest cap across the tenant's active subscriptions. */
export async function assertManagementUserLimits(tx: Tx, tenantId: string, excludeUserId: string | null): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`management-users:${tenantId}`]);
  const { max_management_users } = await one<{ max_management_users: number | null }>(
    tx,
    `SELECT MIN((s.plan_snapshot->>'maxManagementUsers')::int) AS max_management_users
       FROM app.subscriptions s
      WHERE s.tenant_id = $1 AND s.status IN ('active', 'scheduled')`,
    [tenantId],
  );
  const limit = max_management_users ?? DEFAULT_MAX_MANAGEMENT_USERS;
  const { count } = await one<{ count: number }>(
    tx,
    `SELECT count(*)::int AS count FROM app.users
      WHERE tenant_id = $1 AND is_management AND status IN ('active', 'invited') AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [tenantId, excludeUserId],
  );
  if (count + 1 > limit) {
    throw unprocessable(
      'MANAGEMENT_LIMIT_REACHED',
      `This plan allows at most ${limit} Management user(s) – contact your provider to upgrade.`,
      { limit },
    );
  }
}
