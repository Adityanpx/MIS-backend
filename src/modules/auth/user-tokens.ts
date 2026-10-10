import { env } from '../../config/env';
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES } from '../../config/constants';
import { exec } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { randomToken, sha256 } from '../../lib/crypto';
import { queueEmail, renderEmail } from '../notifications/email.service';

export type UserTokenPurpose = 'invite' | 'reset';

/** Creates a single-use token; only its SHA-256 is stored. Earlier unused tokens of the same purpose stop working. */
export async function createUserToken(
  tx: Tx,
  tenantId: string,
  userId: string,
  purpose: UserTokenPurpose,
): Promise<string> {
  const raw = randomToken();
  await exec(
    tx,
    `UPDATE app.auth_tokens SET used_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND purpose = $3 AND used_at IS NULL`,
    [tenantId, userId, purpose],
  );
  const ttl = purpose === 'invite' ? `${INVITE_TTL_HOURS} hours` : `${RESET_TTL_MINUTES} minutes`;
  await exec(
    tx,
    `INSERT INTO app.auth_tokens (tenant_id, user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5::interval)`,
    [tenantId, userId, purpose, sha256(raw), ttl],
  );
  return raw;
}

export const clientInviteLink = (raw: string) => `${env.PUBLIC_WEB_URL}/accept-invite/${raw}`;
export const clientResetLink = (raw: string) => `${env.PUBLIC_WEB_URL}/reset-password/${raw}`;

export async function queueClientInviteEmail(
  tx: Tx,
  tenantId: string,
  user: { name: string; email: string },
  raw: string,
  companyName: string,
): Promise<string | null> {
  const email = await renderEmail('AUTH_INVITE_CLIENT', {
    name: user.name, companyName, link: clientInviteLink(raw), expiresIn: `${INVITE_TTL_HOURS / 24} days`,
  });
  return queueEmail(tx, tenantId, [user.email], email);
}

export async function queueClientResetEmail(
  tx: Tx,
  tenantId: string,
  user: { name: string; email: string },
  raw: string,
): Promise<string | null> {
  const email = await renderEmail('AUTH_RESET_CLIENT', {
    name: user.name, link: clientResetLink(raw), expiresIn: `${RESET_TTL_MINUTES} minutes`,
  });
  return queueEmail(tx, tenantId, [user.email], email);
}
