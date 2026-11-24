import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { detached, query, withScope } from '../db.js';
import { fail } from '../lib/errors.js';
import { loadUser, verifyFileSig } from '../lib/security.js';
import { HEAD_BYTES, contentMatches } from '../lib/sniff.js';
import { PgRateLimitStore } from '../lib/ratestore.js';
import { storage } from '../lib/storage.js';
import { apiBase } from '../lib/tenant.js';

if (config.storage.driver === 'disk') fs.mkdirSync(config.uploadDir, { recursive: true });

export const RULES = {
  photo:        { roles: null, visibility: 'public',  maxMb: 5,   mime: /^image\/(png|jpe?g|webp|gif)$/ },
  thumbnail:    { roles: ['teacher', 'admin'], visibility: 'public',  maxMb: 5,   mime: /^image\/(png|jpe?g|webp|gif)$/ },
  lesson_file:  { roles: ['teacher', 'admin'], visibility: 'private', maxMb: 50,
    mime: /^(application\/(pdf|zip|vnd\.openxmlformats-officedocument\.(presentationml\.presentation|wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-powerpoint|msword|vnd\.ms-excel)|text\/plain|image\/(png|jpe?g))$/ },
  lesson_video: { roles: ['teacher', 'admin'], visibility: 'private', maxMb: 500, mime: /^video\/(mp4|webm|ogg|quicktime)$/ },
  logo:         { roles: ['admin'], visibility: 'public', maxMb: 2, mime: /^image\/(png|jpe?g)$/ },   // organisation logo (also printed on certificates)
};

const MB = 1024 * 1024;
const extOf = (name) => path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);

/*
 * Two ways in, chosen by the storage driver (the browser asks POST /upload/init which one to use):
 *  - "form":   multipart POST /upload?purpose=  (disk storage; development and a single server)
 *  - "direct": POST /upload/init returns a signed address, the browser PUTs the file to the bucket, then POST /upload/complete
 *              confirms it (Cloud Run cannot take large request bodies, and the app should not carry 500 MB videos anyway).
 * Both are refused BEFORE any file bytes are read unless the caller is signed in, allowed this purpose, within the size cap and
 * within the organisation's storage quota.
 */
async function authorize(req, res, purpose, length) {
  const rule = RULES[purpose];
  if (!rule) fail(400, 'Unknown upload purpose');
  await withScope({ tenant: req.tenant, bypass: false }, async () => {
    await loadUser(req, res);
    if (!req.user) fail(401, 'Please sign in');
    if (req.tenant.status === 'suspended' && !req.user.isSuper) fail(403, 'This organisation is suspended. Contact the platform administrator.', { code: 'TENANT_SUSPENDED' });
    if (req.user.isSuper && purpose === 'photo') fail(403, 'Use the platform console for your own account');
    if (rule.roles && !rule.roles.includes(req.user.role)) fail(403, 'You cannot upload this kind of file');
    if (!Number.isFinite(length) || length <= 0) fail(411, 'The upload must declare its size');
    if (length > rule.maxMb * MB + (storage.direct ? 0 : 64 * 1024)) fail(413, `Files of this kind can be at most ${rule.maxMb} MB`);
    const { rows: [{ used }] } = await query(`SELECT coalesce(sum(size_bytes), 0)::float8 AS used FROM files`);
    if (used + length > config.orgStorageMb * MB) fail(413, 'This organisation has used all of its file storage. Delete unused files or contact the platform administrator.', { code: 'STORAGE_FULL' });
  });
  req.uploadPurpose = purpose;
}

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.uploadsPerHour, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `${req.tenant.id}|${req.user.id}`,
  validate: { keyGeneratorIpFallback: false },
  ...(config.rateLimitStore === 'postgres' ? (() => { const store = new PgRateLimitStore(); store.prefix = 'upload:'; return { store, passOnStoreError: true }; })() : {}),
  skip: (req) => req.path.endsWith('/init') && !storage.direct,   // on disk, init only points at the form upload, which is counted itself
  message: { error: 'You have uploaded a lot of files recently. Please try again later.' },
});

// ---- form (multipart) uploads
const diskStorage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${extOf(file.originalname)}`),
});
const uploaders = Object.fromEntries(Object.entries(RULES).map(([purpose, r]) =>
  [purpose, multer({ storage: diskStorage, limits: { fileSize: r.maxMb * MB, files: 1 } }).single('file')]));

async function formGate(req, res, next) {
  if (storage.direct) fail(400, 'Uploads in this deployment go directly to storage. Ask POST /upload/init first.', { code: 'USE_DIRECT_UPLOAD' });
  await authorize(req, res, String(req.query.purpose ?? ''), Number(req.get('content-length')));
  next();
}
export const uploadMiddleware = [formGate, uploadLimiter, (req, res, next) => uploaders[req.uploadPurpose](req, res, next)];

const publicFile = (row, rule) => ({
  id: row.id, name: row.original_name, size: Number(row.size_bytes), mime: row.mime_type,
  url: rule.visibility === 'public' ? `${apiBase()}/files/${row.id}` : null,
});

/** POST /api/:tenant/upload?purpose=... (multipart: file). */
export async function uploadHandler(req) {
  const rule = RULES[req.uploadPurpose];
  const f = req.file;
  const cleanup = () => f && fs.promises.unlink(f.path).catch(() => {});
  try {
    if (!req.user) fail(401, 'Please sign in');
    if (!f) fail(400, 'Choose a file to upload');
    if (!rule.mime.test(f.mimetype)) fail(400, 'This file type is not allowed');
    if (f.size > rule.maxMb * MB) fail(400, `Files of this kind can be at most ${rule.maxMb} MB`);
    if (!contentMatches(f.mimetype, await storage.head({ storage_name: f.filename }))) fail(400, 'The file content does not match its type');
  } catch (e) { await cleanup(); throw e; }
  // Super admins act inside the organisation; the file is owned by the organisation, not by them.
  const owner = req.user.isSuper ? null : req.user.id;
  const { rows: [row] } = await query(
    `INSERT INTO files (owner_id, original_name, mime_type, size_bytes, storage_name, visibility, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [owner, f.originalname.slice(0, 255), f.mimetype, f.size, f.filename, rule.visibility, req.uploadPurpose]).catch(async (e) => { await cleanup(); throw e; });
  return { file: publicFile(row, rule) };
}

// ---- direct uploads
const initSchema = z.object({
  purpose: z.enum(Object.keys(RULES)), name: z.string().trim().min(1).max(255), mime: z.string().trim().max(100), size: z.number().int().positive(),
});

export const uploadInitMiddleware = [
  async (req, res, next) => {
    const parsed = initSchema.safeParse(req.body?.data ?? req.body);
    if (!parsed.success) fail(400, `${parsed.error.issues[0].path.join('.') || 'input'}: ${parsed.error.issues[0].message}`);
    req.uploadInit = parsed.data;
    await authorize(req, res, parsed.data.purpose, parsed.data.size);
    next();
  },
  uploadLimiter,
];

/** POST /api/t/:tenant/upload/init { purpose, name, mime, size } -> how to upload. */
export async function uploadInitHandler(req) {
  const { purpose, name, mime, size } = req.uploadInit;
  const rule = RULES[purpose];
  if (!rule.mime.test(mime)) fail(400, 'This file type is not allowed');
  if (!storage.direct) return { mode: 'form', url: `${apiBase()}/upload?purpose=${purpose}` };
  const owner = req.user.isSuper ? null : req.user.id;
  const storageName = `${crypto.randomUUID()}${extOf(name)}`;
  const { rows: [row] } = await query(
    `INSERT INTO files (owner_id, original_name, mime_type, size_bytes, storage_name, visibility, purpose, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [owner, name.slice(0, 255), mime, size, storageName, rule.visibility, purpose]);
  const upload = await storage.signedUpload(row, { contentType: mime, size });
  return { mode: 'direct', fileId: row.id, upload };
}

/** POST /api/t/:tenant/upload/complete { fileId } -> verifies what actually arrived, then makes the file usable. */
export async function uploadCompleteHandler(req) {
  if (!req.user) fail(401, 'Please sign in');
  const fileId = String(req.body?.data?.fileId ?? req.body?.fileId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) fail(400, 'fileId is required');
  const owner = req.user.isSuper ? null : req.user.id;
  const { rows: [f] } = await query(`SELECT * FROM files WHERE id = $1 AND status = 'pending' AND owner_id IS NOT DISTINCT FROM $2`, [fileId, owner]);
  if (!f) fail(404, 'No pending upload with this id');
  const rule = RULES[f.purpose];
  const reject = async (message) => {
    await storage.remove(f);
    await detached((c) => c.query(`DELETE FROM files WHERE id = $1`, [f.id]));   // own transaction: the request itself is about to be rolled back
    fail(400, message);
  };
  const seen = await storage.stat(f);
  if (!seen) fail(409, 'The file has not arrived yet. Upload it, then confirm again.', { code: 'NOT_UPLOADED' });
  if (seen.size !== Number(f.size_bytes) || seen.size > rule.maxMb * MB) await reject('The uploaded file is not the size that was announced');
  if (seen.contentType !== f.mime_type) await reject('The uploaded file is not the type that was announced');
  if (!contentMatches(f.mime_type, (await storage.head(f)).subarray(0, HEAD_BYTES))) await reject('The file content does not match its type');
  const { rows: [row] } = await query(`UPDATE files SET status = 'ready' WHERE id = $1 RETURNING *`, [f.id]);
  return { file: publicFile(row, rule) };
}

/** GET /api/:tenant/files/:id — public files openly; private lesson files with a signed URL (issued after an enrolment check).
 *  Only files of this organisation can be found (row-level security), and only confirmed uploads. */
export async function fileHandler(req, res) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) fail(404, 'File not found');
  const { rows: [f] } = await query(`SELECT * FROM files WHERE id = $1 AND status = 'ready'`, [req.params.id]);
  if (!f) fail(404, 'File not found');
  const isPrivate = f.visibility === 'private';
  if (isPrivate) {
    const isOwner = req.user && req.user.id === f.owner_id;
    if (!isOwner && !verifyFileSig(f.id, req.query.exp, req.query.sig)) fail(403, 'This link has expired. Reopen the lesson.');
  }
  const inline = /^(image|video)\//.test(f.mime_type) || f.mime_type === 'application/pdf';
  const wantsInline = inline && req.query.download === undefined;

  if (storage.kind === 'gcs') {
    if (isPrivate) {   // hand the browser a short-lived address on the bucket: Google serves it (ranges, large videos)
      const url = await storage.signedDownload(f, { filename: f.original_name, inline: wantsInline, contentType: f.mime_type });
      res.set('Cache-Control', 'private, no-store');
      return void res.redirect(302, url);
    }
    res.set({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Type': f.mime_type,
      'Content-Disposition': `${wantsInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}` });
    const stream = await storage.createReadStream(f);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File missing on the server' }); else res.destroy(); });
    return void stream.pipe(res);
  }

  res.set('Cache-Control', isPrivate ? 'private, max-age=600' : 'public, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${wantsInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.type(f.mime_type);
  res.sendFile(path.join(config.uploadDir, f.storage_name), { headers: { 'Content-Type': f.mime_type } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing on the server' });
  });
  return undefined;
}
