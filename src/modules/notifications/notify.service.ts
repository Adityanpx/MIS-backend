import { env } from '../../config/env';
import { many } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import type { PlantRole } from '../../shared/enums';
import { queueEmail, renderEmail } from './email.service';

export interface Recipient { id: string; name: string; email: string; prefs: Record<string, boolean> }

/** Active users of the tenant: Client Admins (if asked) + users holding one of `roles` on the plant. */
export async function plantRecipients(
  tx: Tx, tenantId: string, plantId: string | null, roles: Array<PlantRole | 'client_admin'>,
): Promise<Recipient[]> {
  const rows = await many<{ id: string; name: string; email: string; notification_prefs: Record<string, boolean> }>(tx,
    `SELECT DISTINCT u.id, u.name, u.email, u.notification_prefs FROM app.users u
      LEFT JOIN app.user_plant_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id AND r.plant_id = $2
      WHERE u.tenant_id = $1 AND u.status = 'active'
        AND (($3 AND u.is_client_admin) OR (r.role = ANY($4::text[])))`,
    [tenantId, plantId, roles.includes('client_admin'), roles.filter((r) => r !== 'client_admin')]);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, prefs: r.notification_prefs ?? {} }));
}

export interface NotifyInput {
  tenantId: string;
  to: Recipient[];
  code: string;            // N-O02 …
  title: string;
  body: string;
  link?: string;           // path in the client app, e.g. /plants/<id>/mis?date=2026-09-21
  email?: boolean;         // also send an email (OPS_GENERIC template)
  critical?: boolean;      // ignores user preferences (§18.2)
}

/** Inserts in-app notifications (+ queued emails) inside the caller's transaction. Returns outbox ids to send after commit. */
export async function notify(tx: Tx, n: NotifyInput): Promise<Array<string | null>> {
  const outbox: Array<string | null> = [];
  for (const u of n.to) {
    if (!n.critical && u.prefs[n.code] === false) continue;
    await tx.query(
      `INSERT INTO app.notifications (tenant_id, user_id, template_code, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
      [n.tenantId, u.id, n.code, n.title, n.body, n.link ?? null]);
    if (n.email && u.prefs[`${n.code}:email`] !== false) {
      const mail = await renderEmail('OPS_GENERIC', {
        name: u.name, title: n.title, body: n.body, link: `${env.PUBLIC_WEB_URL}${n.link ?? ''}`,
      });
      outbox.push(await queueEmail(tx, n.tenantId, [u.email], mail));
    }
  }
  return outbox;
}
