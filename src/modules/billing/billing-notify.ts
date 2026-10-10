import { env } from '../../config/env';
import { many, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { queueEmail, renderEmail } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import type { TemplateVars } from '../notifications/template';

/** Returns true the FIRST time a key is claimed for a tenant (the notice may be sent). */
export async function claimReminder(tx: Tx, tenantId: string, key: string): Promise<boolean> {
  const r = await tx.query('INSERT INTO app.reminder_log (tenant_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantId, key]);
  return (r.rowCount ?? 0) > 0;
}

export const billingLink = (path = '/billing') => `${env.PUBLIC_WEB_URL}${path}`;

export interface ClientNotice {
  tenantId: string;
  code: string;          // N-B01 … N-B12 (also the email template code)
  title: string;         // in-app title
  body: string;          // in-app body
  link?: string;         // client-app path, default /billing
  vars: TemplateVars;    // email placeholders (clientName and billingLink are added)
  dedupeKey?: string;
}

/** In-app (Client Admins) + email (billing emails ∪ Client Admins), inside the caller's transaction. */
export async function notifyClientBilling(tx: Tx, n: ClientNotice): Promise<Array<string | null>> {
  if (n.dedupeKey && !(await claimReminder(tx, n.tenantId, n.dedupeKey))) return [];
  const client = await one<{ display_name: string; legal_name: string; billing_emails: string[]; status: string }>(
    tx, 'SELECT display_name, legal_name, billing_emails, status FROM app.clients WHERE id = $1', [n.tenantId]);
  if (client.status === 'deleted') return [];
  const admins = await plantRecipients(tx, n.tenantId, null, ['client_admin']);
  const outbox = await notify(tx, {
    tenantId: n.tenantId, to: admins, code: n.code, title: n.title, body: n.body, link: n.link ?? '/billing', critical: true,
  });
  const to = [...new Set([...client.billing_emails, ...admins.map((a) => a.email)].map((e) => e.toLowerCase()))];
  const mail = await renderEmail(n.code, { clientName: client.legal_name, billingLink: billingLink(), payLink: billingLink(), ...n.vars });
  outbox.push(await queueEmail(tx, n.tenantId, to, mail));
  return outbox;
}

export interface AdminAlert {
  code: string;          // N-S01 … N-S06
  title: string;
  body: string;
  link?: string;         // Super Admin panel path, e.g. /payments/<id>
  clientId?: string | null;
  dedupeKey?: string;
  email?: boolean;
}

/** admin_notifications row (+ email to every active Super Admin). Returns outbox ids. */
export async function notifySuperAdmins(tx: Tx, a: AdminAlert): Promise<Array<string | null>> {
  const r = await tx.query(
    `INSERT INTO app.admin_notifications (code, title, body, link, client_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [a.code, a.title, a.body, a.link ?? null, a.clientId ?? null, a.dedupeKey ?? null],
  );
  if ((r.rowCount ?? 0) === 0 || !a.email) return [];
  const admins = await many<{ email: string }>(tx, `SELECT email FROM app.super_admins WHERE status = 'active'`);
  const mail = await renderEmail('ADMIN_ALERT', {
    code: a.code, title: a.title, body: a.body, link: `${env.PUBLIC_ADMIN_URL}${a.link ?? '/'}`,
  });
  return [await queueEmail(tx, null, admins.map((x) => x.email), mail)];
}
