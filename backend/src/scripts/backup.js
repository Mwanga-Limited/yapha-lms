// Cloud backup (runs as a Cloud Run Job every night; also `npm run backup`):
//   1. dump the database (plain SQL with INSERTs, gzip) into the BACKUP bucket, which is in another region and has a locked retention period;
//   2. copy every uploaded file the backup bucket does not have yet (uploads are never overwritten, so a copy is a complete copy);
//   3. write manifest.json with counts, so a restore can verify it got everything.
// Neon's own point-in-time recovery stays the first line of defence; this is the independent copy.
//
// Why INSERTs: row-level security is FORCED on every table, and a restoring user that is not a superuser cannot COPY into such tables.
// The dump runs with the platform bypass flag set for that one session only.
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import pg from 'pg';
import { logger } from '../lib/logger.js';

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`Set ${n}`); return v; };
const BACKUP_BUCKET = need('BACKUP_BUCKET');
const UPLOADS_BUCKET = need('GCS_BUCKET');
// pg_dump needs a direct connection (a pooler such as Neon's rejects its session settings): DATABASE_URL_UNPOOLED, else DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED || need('DATABASE_URL');

const started = Date.now();
try {
  const storage = new Storage();
  const backup = storage.bucket(BACKUP_BUCKET);
  const uploads = storage.bucket(UPLOADS_BUCKET);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');   // 20261109T020000Z
  const prefix = `db/${stamp}`;

  // 1. database. The size is checked: an empty or tiny dump means pg_dump failed even if it exited quietly.
  const dump = spawn('pg_dump', ['--format=plain', '--inserts', '--no-owner', '--no-privileges', '--enable-row-security', DATABASE_URL],
    // PGSSLROOTCERT=system: a verify-full connection string (Neon's) makes libpq look for ~/.postgresql/root.crt; use the image's trusted roots instead.
    { env: { PGSSLROOTCERT: 'system', ...process.env, PGOPTIONS: `${process.env.PGOPTIONS ?? ''} -c app.bypass=on`.trim() }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => { dump.on('error', reject); dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}`)))); });
  const out = backup.file(`${prefix}/database.sql.gz`);
  await Promise.all([pipeline(dump.stdout, zlib.createGzip(), out.createWriteStream({ contentType: 'application/gzip', resumable: false })), exited]);
  const [meta] = await out.getMetadata();
  if (Number(meta.size) < 1024) throw new Error(`database dump is only ${meta.size} bytes`);

  // 2. uploaded files (copy what is missing)
  const [existing] = await backup.getFiles({ prefix: 'files/', autoPaginate: true });
  const have = new Set(existing.map((f) => f.name));
  const [objects] = await uploads.getFiles({ prefix: 'tenants/', autoPaginate: true });
  let copied = 0;
  for (const o of objects) {
    if (have.has(`files/${o.name}`)) continue;
    await o.copy(backup.file(`files/${o.name}`));
    copied += 1;
  }

  // 3. what the database says exists versus what is in the file copy
  const client = new pg.Client({ connectionString: DATABASE_URL, options: '-c app.bypass=on' });
  await client.connect();
  const { rows: [counts] } = await client.query(`SELECT (SELECT count(*) FROM files WHERE status = 'ready')::int AS files, (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM tenants)::int AS tenants`).finally(() => client.end());
  const manifest = { created: new Date().toISOString(), databaseDump: `${prefix}/database.sql.gz`, databaseBytes: Number(meta.size), fileObjectsInBucket: objects.length, fileObjectsCopiedNow: copied, ...counts };
  await backup.file(`${prefix}/manifest.json`).save(JSON.stringify(manifest, null, 2), { contentType: 'application/json', resumable: false });
  await backup.file('latest.json').save(JSON.stringify(manifest), { contentType: 'application/json', resumable: false });

  // Cloud Logging turns this line into the "backup succeeded" metric; an alert fires when it is missing for 26 hours.
  logger.info('backup completed', { event: 'backup_completed', seconds: Math.round((Date.now() - started) / 1000), ...manifest });
} catch (e) {
  logger.error('backup failed', { event: 'backup_failed', err: e });
  process.exitCode = 1;
}
