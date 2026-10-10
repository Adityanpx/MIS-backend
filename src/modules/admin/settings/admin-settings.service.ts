import { randomUUID } from 'node:crypto';
import { z, type ZodTypeAny } from 'zod';
import { many, maybeOne } from '../../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../../db/tenant';
import { encrypt } from '../../../lib/crypto';
import { badRequest, notFound } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { MAX_CONTRACT_YEARS } from '../../../shared/constants';
import type { SettingsGroup } from '../../../shared/enums';
import { address, email, gstin, moneyString, pan, stateCode } from '../../../shared/schemas/common';
import { adminActor, diff, writeAudit } from '../../audit/audit.service';
import { signedUrlOrNull, storage } from '../../files/storage';
import { razorpay } from '../../billing/razorpay/gateway';
import { clearTemplateCache } from '../../notifications/email.service';
import { clearSettingsCache } from '../../platform/settings.service';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const days = z.array(int(1, 400)).max(20);

const SCHEMAS: Record<SettingsGroup, { key: string; schema: ZodTypeAny }> = {
  company: { key: 'seller.company', schema: z.object({
    legalName: z.string().trim().min(2).max(200), tradeName: z.string().trim().max(200).default(''),
    address: address, stateCode, gstin, pan, cin: z.string().trim().max(30).default(''),
    email: email, phone: z.string().trim().max(20).default(''),
    bank: z.object({ accountName: z.string().trim().max(200), accountNo: z.string().trim().max(30), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/), branch: z.string().trim().max(200) }).strict(),
    upiId: z.string().trim().max(100).default(''),
    signatory: z.object({ name: z.string().trim().min(2).max(120), designation: z.string().trim().max(120) }).strict(),
    footerTerms: z.string().trim().max(2000).default(''),
  }).strict().refine((s) => s.gstin.slice(0, 2) === s.stateCode, { path: ['gstin'], message: 'GSTIN state code must match the state' }) },
  tax: { key: 'tax', schema: z.object({
    gstRatePct: z.coerce.number().min(0).max(28), sac: z.string().regex(/^\d{6}$/), tdsSections: z.array(z.string().trim().min(2).max(20)).min(1).max(20),
    closeTolerance: moneyString,
  }).strict() },
  numbering: { key: 'numbering', schema: z.object({
    invoicePrefix: z.string().regex(/^[A-Z]{1,8}$/), creditNotePrefix: z.string().regex(/^[A-Z]{1,8}$/), receiptPrefix: z.string().regex(/^[A-Z]{1,8}$/),
  }).strict() },
  billing: { key: 'billing', schema: z.object({
    invoiceLeadDays: int(0, 120), minPaymentTermsDays: int(0, 90), autoIssue: z.boolean(), autoApplyCredit: z.boolean(),
    gatewayFeeMode: z.enum(['absorb', 'convenience']), gatewayFeePct: z.coerce.number().min(0).max(5), linkExpiryDaysAfterDue: int(1, 180),
  }).strict() },
  lifecycle: { key: 'lifecycle', schema: z.object({
    graceDays: int(0, 90), readOnlyDays: int(0, 90), suspendedDays: int(1, 365), retentionDays: int(30, 3650),
    chequePauseMaxDays: int(0, 60), renewalWindowDays: int(0, 180), expiringAlertDays: int(1, 180),
  }).strict() },
  reminders: { key: 'reminders', schema: z.object({ preDueDays: days, overdueDays: days, renewalDays: days }).strict() },
  plans: { key: 'plans.allowed_terms', schema: z.object({ allowedTerms: z.array(int(1, MAX_CONTRACT_YEARS)).min(1).max(15) }).strict() },
  'payment-gateway': { key: 'payment_gateway', schema: z.object({
    mode: z.enum(['test', 'live']), keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/),
    keySecret: z.string().trim().min(10).max(200).optional(), webhookSecret: z.string().trim().min(8).max(200).optional(),
  }).strict() },
  email: { key: 'email', schema: z.object({ senderName: z.string().trim().max(100), replyTo: email.or(z.literal('')) }).strict() },
  branding: { key: 'platform.branding', schema: z.object({
    name: z.string().trim().min(2).max(60), supportEmail: email, supportPhone: z.string().trim().max(20).default(''),
    termsVersion: z.string().trim().regex(/^[0-9A-Za-z._-]{1,30}$/), termsUrl: z.string().url().or(z.literal('')), privacyUrl: z.string().url().or(z.literal('')),
  }).strict() },
  security: { key: 'security', schema: z.object({ clientIdleMinutes: int(15, 1440), adminIdleMinutes: int(5, 240) }).strict() },
  'act-as': { key: 'act_as', schema: z.object({ emailClientOnEdit: z.boolean() }).strict() },
};

async function readKeys(ctx: AdminTxCtx, keys: string[]) {
  return withAdmin(ctx, (tx) => many<{ key: string; value: Record<string, unknown> | unknown[] }>(
    tx, 'SELECT key, value FROM app.platform_settings WHERE key = ANY($1::text[])', [keys]));
}

/** Public view of a group (secrets masked, read-only extras added). */
export async function getGroup(ctx: AdminTxCtx, group: SettingsGroup) {
  const def = SCHEMAS[group];
  const keys = group === 'branding' ? ['platform.branding', 'legal.terms'] : [def.key];
  const rows = await readKeys(ctx, keys);
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  switch (group) {
    case 'plans': return { allowedTerms: (v(def.key) as number[] | undefined) ?? [5, 10, 15] };
    case 'payment-gateway': {
      const g = (v(def.key) ?? {}) as { mode?: string; keyId?: string; keySecretEnc?: string | null; webhookSecretEnc?: string | null };
      return { mode: g.mode ?? 'test', keyId: g.keyId ?? '', keySecretSet: !!g.keySecretEnc, webhookSecretSet: !!g.webhookSecretEnc,
        webhookUrl: '/webhooks/razorpay' };
    }
    case 'branding': {
      const b = (v('platform.branding') ?? {}) as Record<string, unknown>;
      const t = (v('legal.terms') ?? {}) as Record<string, unknown>;
      return { ...b, logoUrl: await signedUrlOrNull(b.logoKey as string | null), termsVersion: t.version ?? '', termsUrl: t.termsUrl ?? '', privacyUrl: t.privacyUrl ?? '' };
    }
    case 'company': {
      const s = (v(def.key) ?? {}) as Record<string, unknown>;
      return { ...s, logoUrl: await signedUrlOrNull(s.logoKey as string | null) };
    }
    case 'numbering': {
      const seq = await withAdmin(ctx, (tx) => many(tx, 'SELECT doc_type AS "docType", fy, prefix, last_no AS "lastNo" FROM app.doc_sequences ORDER BY fy DESC, doc_type'));
      return { ...((v(def.key) ?? {}) as object), sequences: seq };
    }
    default: return v(def.key) ?? {};
  }
}

export async function getAll(ctx: AdminTxCtx) {
  const out: Record<string, unknown> = {};
  for (const g of Object.keys(SCHEMAS) as SettingsGroup[]) out[g] = await getGroup(ctx, g);
  return out;
}

async function upsert(ctx: AdminTxCtx, key: string, value: unknown, isPublic: boolean, meta: RequestMeta, group: string) {
  await withAdmin(ctx, async (tx) => {
    const before = await maybeOne<{ value: unknown }>(tx, 'SELECT value FROM app.platform_settings WHERE key = $1 FOR UPDATE', [key]);
    await tx.query(
      `INSERT INTO app.platform_settings (key, value, is_public, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, now(), $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), isPublic, ctx.adminId],
    );
    const b = (before?.value ?? {}) as Record<string, unknown>;
    const a = value as Record<string, unknown>;
    await writeAudit(tx, adminActor(ctx.adminId), {
      action: 'settings.update', entity: 'platform_setting', entityId: key,
      ...(Array.isArray(a) || Array.isArray(b) ? { before: b, after: a } : diff(b, a)), reason: group,
    }, meta);
  });
}

export async function putGroup(ctx: AdminTxCtx, group: SettingsGroup, body: unknown, meta: RequestMeta) {
  const def = SCHEMAS[group];
  const input = def.schema.parse(body) as Record<string, unknown>;
  const current = ((await readKeys(ctx, [def.key]))[0]?.value ?? {}) as Record<string, unknown>;
  switch (group) {
    case 'plans':
      await upsert(ctx, def.key, [...new Set(input.allowedTerms as number[])].sort((x, y) => x - y), false, meta, group);
      break;
    case 'payment-gateway': {
      const next = {
        mode: input.mode, keyId: input.keyId,
        keySecretEnc: input.keySecret ? encrypt(String(input.keySecret)) : current.keySecretEnc ?? null,
        webhookSecretEnc: input.webhookSecret ? encrypt(String(input.webhookSecret)) : current.webhookSecretEnc ?? null,
      };
      if (String(input.keyId).startsWith('rzp_live_') !== (input.mode === 'live')) {
        throw badRequest('KEY_MODE_MISMATCH', 'The key ID does not match the selected mode (test/live).');
      }
      await upsert(ctx, def.key, next, false, meta, group);
      break;
    }
    case 'branding': {
      const { termsVersion, termsUrl, privacyUrl, ...brand } = input;
      await upsert(ctx, 'platform.branding', { ...current, ...brand }, true, meta, group);
      await upsert(ctx, 'legal.terms', { version: termsVersion, termsUrl, privacyUrl }, true, meta, group); // new version → re-acceptance (AUTH-12)
      break;
    }
    case 'company':
      await upsert(ctx, def.key, { ...input, logoKey: current.logoKey ?? null }, false, meta, group);
      break;
    default:
      await upsert(ctx, def.key, input, false, meta, group);
  }
  clearSettingsCache();
  return getGroup(ctx, group);
}

/** Seller logo (invoices) and platform logo (login pages): stored under the `platform/` prefix. */
export async function setLogo(ctx: AdminTxCtx, group: 'company' | 'branding', file: { ext: string; mime: string; buffer: Buffer }, meta: RequestMeta) {
  const key = `platform/${group}/logo-${randomUUID()}.${file.ext}`;
  await storage.put(key, file.buffer, file.mime);
  const settingKey = group === 'company' ? 'seller.company' : 'platform.branding';
  const current = ((await readKeys(ctx, [settingKey]))[0]?.value ?? {}) as Record<string, unknown>;
  await upsert(ctx, settingKey, { ...current, logoKey: key }, group === 'branding', meta, `${group}.logo`);
  clearSettingsCache();
  if (typeof current.logoKey === 'string') await storage.remove(current.logoKey).catch(() => undefined);
  return getGroup(ctx, group);
}

/** SST-08 "Test connection". */
export async function testGateway(): Promise<{ ok: boolean; message: string }> {
  clearSettingsCache();
  if (!(await razorpay.configured())) return { ok: false, message: 'Key ID and key secret are not set.' };
  try {
    await razorpay.test();
    return { ok: true, message: 'Connected to Razorpay.' };
  } catch (err) {
    return { ok: false, message: String((err as Error).message).slice(0, 200) };
  }
}

// ------------------------------------------------------------------ email templates (SST-09)
export async function listTemplates(ctx: AdminTxCtx) {
  return withAdmin(ctx, (tx) => many(tx,
    `SELECT code, channel, subject, is_active AS "isActive", updated_at AS "updatedAt" FROM app.notification_templates ORDER BY code`));
}
export async function getTemplate(ctx: AdminTxCtx, code: string) {
  const t = await withAdmin(ctx, (tx) => maybeOne(tx,
    `SELECT code, channel, subject, body_html AS "bodyHtml", body_text AS "bodyText", is_active AS "isActive", updated_at AS "updatedAt"
       FROM app.notification_templates WHERE code = $1`, [code]));
  if (!t) throw notFound('Template');
  return t;
}
export async function putTemplate(
  ctx: AdminTxCtx, code: string, input: { subject: string; bodyHtml: string; bodyText: string; isActive: boolean }, meta: RequestMeta,
) {
  await withAdmin(ctx, async (tx) => {
    const before = await maybeOne<Record<string, unknown>>(tx,
      'SELECT subject, body_html, body_text, is_active FROM app.notification_templates WHERE code = $1 FOR UPDATE', [code]);
    if (!before) throw notFound('Template');
    await tx.query(
      `UPDATE app.notification_templates SET subject = $2, body_html = $3, body_text = $4, is_active = $5, updated_at = now(), updated_by = $6
        WHERE code = $1`,
      [code, input.subject, input.bodyHtml, input.bodyText, input.isActive, ctx.adminId],
    );
    await writeAudit(tx, adminActor(ctx.adminId), {
      action: 'email_template.update', entity: 'notification_template', entityId: code,
      ...diff(before, { subject: input.subject, body_html: input.bodyHtml, body_text: input.bodyText, is_active: input.isActive }),
    }, meta);
  });
  clearTemplateCache();
  return getTemplate(ctx, code);
}
