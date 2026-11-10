import crypto from 'node:crypto';
import { config } from '../config.js';

/*
 * Paystack API (https://paystack.com/docs/api/). Each organisation uses its own secret key.
 * PAYSTACK_API_URL can point at the Paystack test server (backend/test/paystack-test-server.js) in tests.
 */
export class PaystackError extends Error {}

async function call(secretKey, method, path, body) {
  let res;
  try {
    res = await fetch(`${config.paystackApiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PaystackError('Could not reach Paystack. Please try again.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.status) throw new PaystackError(json?.message || `Paystack error (${res.status})`);
  return json.data;
}

/** Start a payment: returns Paystack's checkout page for the learner. */
export const initializeTransaction = (secretKey, { email, amount, currency, reference, callbackUrl, metadata }) =>
  call(secretKey, 'POST', '/transaction/initialize', { email, amount, currency, reference, callback_url: callbackUrl, metadata });

/** Ask Paystack how a payment went (never trust the browser's word for it). */
export const verifyTransaction = (secretKey, reference) =>
  call(secretKey, 'GET', `/transaction/verify/${encodeURIComponent(reference)}`);

/** Check that a webhook really came from Paystack: HMAC-SHA512 of the raw body with the secret key. */
export function validWebhookSignature(secretKey, rawBody, signature) {
  if (!rawBody || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export const KEY_RE = { public: /^pk_(test|live)_[A-Za-z0-9]{20,}$/, secret: /^sk_(test|live)_[A-Za-z0-9]{20,}$/ };
