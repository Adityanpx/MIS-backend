import { many, exec } from '../../db/sql';
import { withSystem, type Tx } from '../../db/tenant';
import { logger } from '../../lib/logger';
import { platformName } from '../platform/settings.service';
import { emailDriver } from './email.adapter';
import { renderString, type TemplateVars } from './template';

export interface RenderedEmail {
  templateCode: string;
  subject: string;
  html: string;
  text: string;
}
interface TemplateRow {
  code: string;
  subject: string;
  body_html: string;
  body_text: string;
  is_active: boolean;
}

const TTL_MS = 60_000;
const templateCache = new Map<string, { at: number; row: TemplateRow | undefined }>();
export function clearTemplateCache(): void {
  templateCache.clear();
}

async function loadTemplate(code: string): Promise<TemplateRow | undefined> {
  const hit = templateCache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  // notification_templates is a platform table: only admin_user can read it (app_user sees nothing).
  const rows = await withSystem((tx) =>
    many<TemplateRow>(
      tx,
      'SELECT code, subject, body_html, body_text, is_active FROM app.notification_templates WHERE code = $1',
      [code],
    ),
  );
  templateCache.set(code, { at: Date.now(), row: rows[0] });
  return rows[0];
}

/** Renders a template. Returns null (and logs) when it is missing or switched off. */
export async function renderEmail(code: string, vars: TemplateVars): Promise<RenderedEmail | null> {
  const tpl = await loadTemplate(code);
  if (!tpl || !tpl.is_active) {
    logger.warn({ template: code }, 'Email template missing or inactive; email skipped');
    return null;
  }
  const all: TemplateVars = { platformName: await platformName(), ...vars };
  return {
    templateCode: code,
    subject: renderString(tpl.subject, all, false),
    html: renderString(tpl.body_html, all, true),
    text: renderString(tpl.body_text, all, false),
  };
}

/** Inserts an email_outbox row inside the caller's transaction. Returns the outbox id (or null if skipped). */
export async function queueEmail(
  tx: Tx,
  tenantId: string | null,
  to: string[],
  email: RenderedEmail | null,
): Promise<string | null> {
  if (!email || to.length === 0) return null;
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.email_outbox (tenant_id, to_emails, template_code, subject, body_html, body_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, to, email.templateCode, email.subject, email.html, email.text],
  );
  return r.rows[0]?.id ?? null;
}

const MAX_ATTEMPTS = 5;

/** Sends queued outbox rows. Never throws: failures are stored on the row. */
export async function dispatchEmails(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await withSystem((tx) =>
    many<{ id: string; to_emails: string[]; subject: string; body_html: string; body_text: string }>(
      tx,
      `SELECT id, to_emails, subject, body_html, body_text
         FROM app.email_outbox WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
      [ids],
    ),
  );
  for (const row of rows) {
    try {
      const { providerId } = await emailDriver.send({
        to: row.to_emails, subject: row.subject, html: row.body_html, text: row.body_text,
      });
      await withSystem((tx) =>
        exec(
          tx,
          `UPDATE app.email_outbox SET status = 'sent', attempts = attempts + 1, provider_id = $2,
                  sent_at = now(), error = NULL WHERE id = $1`,
          [row.id, providerId],
        ),
      );
    } catch (err) {
      logger.error({ err, outboxId: row.id }, 'Email send failed');
      await withSystem((tx) =>
        exec(
          tx,
          `UPDATE app.email_outbox
              SET attempts = attempts + 1, error = $2,
                  status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'queued' END
            WHERE id = $1`,
          [row.id, String((err as Error).message).slice(0, 500), MAX_ATTEMPTS],
        ),
      ).catch((e2) => logger.error({ err: e2 }, 'Could not record email failure'));
    }
  }
}

const pending = new Set<Promise<void>>();

/** Fire-and-forget sending AFTER the transaction committed. Request latency is not affected. */
export function sendInBackground(ids: Array<string | null>): void {
  const real = ids.filter((x): x is string => !!x);
  if (real.length === 0) return;
  const p: Promise<void> = dispatchEmails(real)
    .catch((err) => logger.error({ err }, 'Email dispatch crashed'))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Tests (and graceful shutdown) wait for background sends to finish. */
export async function drainEmails(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
