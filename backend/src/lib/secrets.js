import crypto from 'node:crypto';
import { config } from '../config.js';

/*
 * Encrypts secrets stored in the database (an organisation's Paystack secret key) with AES-256-GCM.
 * The key comes from DATA_ENCRYPTION_KEY, so a copy of the database alone does not reveal the secrets.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
const key = () => crypto.createHash('sha256').update(config.dataEncryptionKey).digest();

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), enc].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}

export function decryptSecret(stored) {
  const [v, iv, tag, enc] = String(stored).split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}
