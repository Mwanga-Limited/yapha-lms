// One-off: copy files that were stored in UPLOAD_DIR (disk) into the Cloud Storage bucket, under the keys the app expects
// (tenants/<tenant_id>/<storage_name>). Safe to re-run: files already in the bucket are skipped. Read-only for the database.
// Usage: UPLOAD_DIR=./uploads GCS_BUCKET=my-bucket npm run files:to-gcs   (then deploy with STORAGE_DRIVER=gcs)
import fs from 'node:fs';
import path from 'node:path';
import { pool, query } from '../db.js';
import { config } from '../config.js';
import { objectKey } from '../lib/storage.js';

process.env.YAPHA_DB_BYPASS = 'on';
const bucketName = process.env.GCS_BUCKET;

try {
  if (!bucketName) throw new Error('Set GCS_BUCKET');
  const { Storage } = await import('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  const { rows } = await query(`SELECT tenant_id, storage_name, mime_type, size_bytes FROM files WHERE status = 'ready' ORDER BY created_at`);
  let copied = 0, skipped = 0;
  const missing = [];
  for (const f of rows) {
    const local = path.join(config.uploadDir, f.storage_name);
    if (!fs.existsSync(local)) { missing.push(f.storage_name); continue; }
    const file = bucket.file(objectKey(f));
    const [exists] = await file.exists();
    if (exists) { skipped += 1; continue; }
    await bucket.upload(local, { destination: objectKey(f), metadata: { contentType: f.mime_type }, resumable: false });
    copied += 1;
  }
  console.log(`copied ${copied}, already there ${skipped}, missing on disk ${missing.length}`);
  if (missing.length) { console.error(`Not found in ${config.uploadDir}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
