import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { query } from '../db.js';
import { fail } from '../lib/errors.js';
import { verifyFileSig } from '../lib/security.js';
import { apiBase } from '../lib/tenant.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const RULES = {
  photo:        { roles: null, visibility: 'public',  maxMb: 5,   mime: /^image\/(png|jpe?g|webp|gif)$/ },
  thumbnail:    { roles: ['teacher', 'admin'], visibility: 'public',  maxMb: 5,   mime: /^image\/(png|jpe?g|webp|gif)$/ },
  lesson_file:  { roles: ['teacher', 'admin'], visibility: 'private', maxMb: 50,
    mime: /^(application\/(pdf|zip|vnd\.openxmlformats-officedocument\.(presentationml\.presentation|wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-powerpoint|msword|vnd\.ms-excel)|text\/plain|image\/(png|jpe?g))$/ },
  lesson_video: { roles: ['teacher', 'admin'], visibility: 'private', maxMb: 500, mime: /^video\/(mp4|webm|ogg|quicktime)$/ },
  logo:         { roles: ['admin'], visibility: 'public', maxMb: 2, mime: /^image\/(png|jpe?g)$/ },   // organisation logo (also printed on certificates)
};

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

// Files are only accepted from requests that carry a session cookie; the session itself is checked in the handler.
const hasSessionCookie = (req) => Object.keys(req.cookies ?? {}).some((k) => k.startsWith('el_'));
export const uploadMiddleware = [
  (req, _res, next) => (hasSessionCookie(req) ? next() : fail(401, 'Please sign in')),
  upload.single('file'),
];

/** POST /api/t/:tenant/upload (multipart: purpose, file). Files belong to the organisation. */
export async function uploadHandler(req) {
  const rule = RULES[req.body?.purpose];
  const f = req.file;
  const cleanup = () => f && fs.promises.unlink(f.path).catch(() => {});
  try {
    if (!req.user) fail(401, 'Please sign in');
    if (!rule) fail(400, 'Unknown upload purpose');
    if (!f) fail(400, 'Choose a file to upload');
    if (req.user.isSuper && req.body.purpose === 'photo') fail(403, 'Use the platform console for your own account');
    if (rule.roles && !rule.roles.includes(req.user.role)) fail(403, 'You cannot upload this kind of file');
    if (!rule.mime.test(f.mimetype)) fail(400, 'This file type is not allowed');
    if (f.size > rule.maxMb * 1024 * 1024) fail(400, `Files of this kind can be at most ${rule.maxMb} MB`);
  } catch (e) { await cleanup(); throw e; }
  // Super admins act inside the organisation; the file is owned by the organisation, not by them.
  const owner = req.user.isSuper ? null : req.user.id;
  const { rows: [row] } = await query(
    `INSERT INTO files (owner_id, original_name, mime_type, size_bytes, storage_name, visibility, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [owner, f.originalname.slice(0, 255), f.mimetype, f.size, f.filename, rule.visibility, req.body.purpose]).catch(async (e) => { await cleanup(); throw e; });
  return { file: { id: row.id, name: f.originalname, size: f.size, mime: f.mimetype, url: rule.visibility === 'public' ? `${apiBase()}/files/${row.id}` : null } };
}

/** GET /api/t/:tenant/files/:id — public files openly; private lesson files with a signed URL (issued after an enrolment check).
 *  Only files of this organisation can be found (row-level security). */
export async function fileHandler(req, res) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) fail(404, 'File not found');
  const { rows: [f] } = await query(`SELECT * FROM files WHERE id = $1`, [req.params.id]);
  if (!f) fail(404, 'File not found');
  if (f.visibility === 'private') {
    const isOwner = req.user && req.user.id === f.owner_id;
    if (!isOwner && !verifyFileSig(f.id, req.query.exp, req.query.sig)) fail(403, 'This link has expired. Reopen the lesson.');
    res.set('Cache-Control', 'private, max-age=600');
  } else {
    res.set('Cache-Control', 'public, max-age=86400');
  }
  const inline = /^(image|video)\//.test(f.mime_type) || f.mime_type === 'application/pdf';
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${inline && req.query.download === undefined ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.type(f.mime_type);
  res.sendFile(path.join(config.uploadDir, f.storage_name), { headers: { 'Content-Type': f.mime_type } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing on the server' });
  });
}
