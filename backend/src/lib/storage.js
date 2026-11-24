import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { HEAD_BYTES } from './sniff.js';

/*
 * Where uploaded files live. Two drivers behind one interface:
 *  - disk: a folder (development, tests, a single server). Uploads go through the app as multipart.
 *  - gcs:  a Google Cloud Storage bucket (Cloud Run has no durable disk). The browser uploads straight to the bucket with a
 *          signed address and reads private files back through short-lived signed addresses, so large videos never pass through the app.
 * A file's location is derived from its row: disk -> UPLOAD_DIR/<storage_name>, gcs -> tenants/<tenant_id>/<storage_name>.
 */
export const objectKey = (f) => `tenants/${f.tenant_id}/${f.storage_name}`;

class DiskStorage {
  kind = 'disk';
  direct = false;
  pathOf(f) { return path.join(config.uploadDir, f.storage_name); }
  async head(f) {
    const h = await fs.promises.open(this.pathOf(f), 'r');
    try { const b = Buffer.alloc(HEAD_BYTES); const { bytesRead } = await h.read(b, 0, HEAD_BYTES, 0); return b.subarray(0, bytesRead); } finally { await h.close(); }
  }
  async readBuffer(f) { return fs.promises.readFile(this.pathOf(f)); }
  async put(f, buffer) { await fs.promises.mkdir(config.uploadDir, { recursive: true }); await fs.promises.writeFile(this.pathOf(f), buffer); }
  async remove(f) { await fs.promises.unlink(this.pathOf(f)).catch(() => {}); }
  async healthy() { try { await fs.promises.access(config.uploadDir, fs.constants.W_OK); return true; } catch { return false; } }
}

class GcsStorage {
  kind = 'gcs';
  direct = true;
  #bucket = null;
  async bucket() {
    if (!this.#bucket) {
      const { Storage } = await import('@google-cloud/storage');
      this.#bucket = new Storage().bucket(config.storage.gcsBucket);   // credentials: the Cloud Run service account (no key files)
    }
    return this.#bucket;
  }
  async file(f) { return (await this.bucket()).file(objectKey(f)); }

  /** A signed address the browser PUTs the file to. The size is fixed by the signature: any other size is refused by Google. */
  async signedUpload(f, { contentType, size, minutes = 15 }) {
    const headers = { 'Content-Type': contentType, 'x-goog-content-length-range': `${size},${size}` };
    const [url] = await (await this.file(f)).getSignedUrl({
      version: 'v4', action: 'write', expires: Date.now() + minutes * 60_000, contentType,
      extensionHeaders: { 'x-goog-content-length-range': headers['x-goog-content-length-range'] },
    });
    return { url, method: 'PUT', headers };
  }
  async stat(f) {
    const [exists] = await (await this.file(f)).exists();
    if (!exists) return null;
    const [m] = await (await this.file(f)).getMetadata();
    return { size: Number(m.size), contentType: m.contentType };
  }
  async head(f) {
    const chunks = [];
    for await (const c of (await this.file(f)).createReadStream({ start: 0, end: HEAD_BYTES - 1 })) chunks.push(c);
    return Buffer.concat(chunks);
  }
  async readBuffer(f) { return (await (await this.file(f)).download())[0]; }
  async put(f, buffer, contentType) { await (await this.file(f)).save(buffer, { contentType, resumable: false }); }
  /** A short-lived address to read a private file (Google handles range requests, so video seeking works). */
  async signedDownload(f, { filename, inline, contentType, seconds = 600 }) {
    const [url] = await (await this.file(f)).getSignedUrl({
      version: 'v4', action: 'read', expires: Date.now() + seconds * 1000, responseType: contentType,
      responseDisposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    return url;
  }
  /** The bucket exists and is reachable. Cached for a minute: health checks arrive every few seconds. */
  #okUntil = 0;
  async healthy() {
    if (Date.now() < this.#okUntil) return true;
    try { const [ok] = await (await this.bucket()).exists(); if (ok) this.#okUntil = Date.now() + 60_000; return ok; } catch { return false; }
  }
  async createReadStream(f) { return (await this.file(f)).createReadStream(); }
  async remove(f) { await (await this.file(f)).delete({ ignoreNotFound: true }).catch(() => {}); }
}

export let storage = config.storage.driver === 'gcs' ? new GcsStorage() : new DiskStorage();
/** Tests swap in a fake (an in-memory "bucket"); never called elsewhere. */
export function setStorageForTests(s) {
  if (!config.isTest) throw new Error('setStorageForTests is only for tests');
  storage = s;
}
