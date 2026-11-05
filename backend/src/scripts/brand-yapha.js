// Applies Yapha's brand to the Yapha organisation: its logo (assets/yapha-logo.png, made from yapha-logo.svg),
// the brand orange (#FF950D) as accent, midnight (#030027) as main colour, and the light header the logo needs.
// Safe to run more than once. Usage: npm run brand:yapha
// The same settings can be changed later in Admin › Settings › Branding.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { settingsOf } from '../lib/tenant.js';

const SLUG = 'yapha';
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/yapha-logo.png');
const BRAND = { accentColor: '#FF950D', primaryColor: '#030027', header: 'light' };

try {
  const { rows: [t] } = await pool.query(`SELECT * FROM tenants WHERE slug = $1`, [SLUG]);
  if (!t) throw new Error(`No organisation at /${SLUG}. Run npm run migrate first.`);

  await tx(async (db) => {
    // Reuse the logo if this script already added it; otherwise store it like an Admin upload.
    let { rows: [file] } = await db.query(
      `SELECT id FROM files WHERE tenant_id = $1 AND purpose = 'logo' AND original_name = 'yapha-logo.png' ORDER BY created_at DESC LIMIT 1`, [t.id]);
    if (!file) {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      const storage = `${crypto.randomUUID()}.png`;
      fs.copyFileSync(LOGO, path.join(config.uploadDir, storage));
      ({ rows: [file] } = await db.query(
        `INSERT INTO files (tenant_id, owner_id, original_name, mime_type, size_bytes, storage_name, visibility, purpose)
         VALUES ($1, NULL, 'yapha-logo.png', 'image/png', $2, $3, 'public', 'logo') RETURNING id`,
        [t.id, fs.statSync(LOGO).size, storage]));
    }
    const before = settingsOf(t);
    const settings = { ...before, branding: { ...before.branding, ...BRAND, logoFileId: file.id } };
    await db.query(`UPDATE tenants SET settings = $2, updated_at = now() WHERE id = $1`, [t.id, settings]);
    await db.query(`INSERT INTO audit_logs (tenant_id, actor_role, action, target_type, target_id, old_values, new_values)
                    VALUES ($1::uuid, 'system', 'tenant.settings_update', 'tenant', $1::text, $2, $3)`,
      [t.id, JSON.stringify({ branding: before.branding }), JSON.stringify({ branding: settings.branding, source: 'brand:yapha script' })]);
  });
  console.log(`Yapha branding applied: logo, accent ${BRAND.accentColor}, main colour ${BRAND.primaryColor}, light header. Open ${config.appUrl}/${SLUG}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
