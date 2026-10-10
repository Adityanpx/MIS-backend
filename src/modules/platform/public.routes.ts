import { Router } from 'express';
import { many } from '../../db/sql';
import { withAuthLookup } from '../../db/tenant';
import { asyncHandler, ok } from '../../lib/http';
import { signedUrlOrNull } from '../files/storage';

interface Branding { name?: string; logoKey?: string | null; supportEmail?: string; supportPhone?: string }
interface Terms { version?: string; termsUrl?: string; privacyUrl?: string }

export const publicRouter = Router();

publicRouter.get(
  '/platform',
  asyncHandler(async (_req, res) => {
    const rows = await withAuthLookup((tx) =>
      many<{ key: string; value: unknown }>(tx, 'SELECT key, value FROM app.public_platform_settings()'),
    );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const branding = (byKey.get('platform.branding') ?? {}) as Branding;
    const terms = (byKey.get('legal.terms') ?? {}) as Terms;
    ok(res, {
      name: branding.name ?? 'OMMIS',
      logoUrl: await signedUrlOrNull(branding.logoKey),
      supportEmail: branding.supportEmail ?? '',
      supportPhone: branding.supportPhone ?? '',
      terms: { version: terms.version ?? '', termsUrl: terms.termsUrl ?? '', privacyUrl: terms.privacyUrl ?? '' },
      announcements: await withAuthLookup((tx) => many(tx,
        `SELECT id, message, level, starts_at AS "startsAt", ends_at AS "endsAt" FROM app.active_announcements()`)),
    });
  }),
);
