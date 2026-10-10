import { withSystem, closeDb } from '../src/db/tenant';
import { hashPassword, assertPasswordPolicy } from '../src/lib/password';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const password = process.env.SUPER_ADMIN_PASSWORD ?? '';
  if (!email || !name) throw new Error('Usage: npm run create-super-admin -- --email <email> --name "<name>" (SUPER_ADMIN_PASSWORD env required)');
  assertPasswordPolicy(password);
  const hash = await hashPassword(password);
  const id = await withSystem(async (tx) => {
    const exists = await tx.query('SELECT 1 FROM app.super_admins WHERE lower(email) = $1', [email]);
    if (exists.rowCount) throw new Error(`Super Admin ${email} already exists`);
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.super_admins (name, email, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
      [name, email, hash],
    );
    const newId = r.rows[0]!.id;
    await tx.query(
      `INSERT INTO app.audit_log (tenant_id, actor_type, action, entity, entity_id, after)
       VALUES (NULL, 'system', 'super_admin.bootstrap', 'super_admin', $1, $2::jsonb)`,
      [newId, JSON.stringify({ email, name })],
    );
    return newId;
  });
  console.log(`Super Admin created: ${email} (${id}). Log in to enrol two-factor authentication.`);
}

main()
  .then(() => closeDb())
  .catch(async (err: Error) => {
    console.error(err.message);
    await closeDb();
    process.exit(1);
  });
