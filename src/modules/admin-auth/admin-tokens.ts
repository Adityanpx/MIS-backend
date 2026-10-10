import { env } from '../../config/env';
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES } from '../../config/constants';
import { exec } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { randomToken, sha256 } from '../../lib/crypto';
import { queueEmail, renderEmail } from '../notifications/email.service';

export async function createAdminToken(tx: Tx, adminId: string, purpose: 'invite' | 'reset'): Promise<string> {
  const raw = randomToken();
  await exec(
    tx,
    `UPDATE app.super_admin_auth_tokens SET used_at = now()
      WHERE super_admin_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [adminId, purpose],
  );
  const ttl = purpose === 'invite' ? `${INVITE_TTL_HOURS} hours` : `${RESET_TTL_MINUTES} minutes`;
  await exec(
    tx,
    `INSERT INTO app.super_admin_auth_tokens (super_admin_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [adminId, purpose, sha256(raw), ttl],
  );
  return raw;
}

export async function queueAdminInviteEmail(tx: Tx, to: { name: string; email: string }, raw: string) {
  const email = await renderEmail('AUTH_INVITE_ADMIN', {
    name: to.name, link: `${env.PUBLIC_ADMIN_URL}/accept-invite/${raw}`, expiresIn: `${INVITE_TTL_HOURS / 24} days`,
  });
  return queueEmail(tx, null, [to.email], email);
}
export async function queueAdminResetEmail(tx: Tx, to: { name: string; email: string }, raw: string) {
  const email = await renderEmail('AUTH_RESET_ADMIN', {
    name: to.name, link: `${env.PUBLIC_ADMIN_URL}/reset-password/${raw}`, expiresIn: `${RESET_TTL_MINUTES} minutes`,
  });
  return queueEmail(tx, null, [to.email], email);
}
