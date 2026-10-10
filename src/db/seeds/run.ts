import { withSystem, closeDb } from '../tenant';
import { PLATFORM_DEFAULTS } from './platform-defaults';
import { EMAIL_TEMPLATES } from './email-templates';

export async function runSeeds(): Promise<void> {
  await withSystem(async (tx) => {
    for (const s of PLATFORM_DEFAULTS) {
      await tx.query(
        `INSERT INTO app.platform_settings (key, value, is_public) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO NOTHING`,
        [s.key, JSON.stringify(s.value), s.isPublic],
      );
    }
    for (const t of EMAIL_TEMPLATES) {
      await tx.query(
        `INSERT INTO app.notification_templates (code, channel, subject, body_html, body_text) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO NOTHING`,
        [t.code, t.channel, t.subject, t.html, t.text],
      );
    }
  });
}

if (require.main === module) {
  runSeeds()
    .then(async () => {
      console.log('Seeds applied');
      await closeDb();
      process.exit(0);
    })
    .catch(async (err: Error) => {
      console.error(err.message);
      await closeDb();
      process.exit(1);
    });
}
