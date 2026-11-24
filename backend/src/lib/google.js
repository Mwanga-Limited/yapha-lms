import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

const client = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;
let override = null;   // tests replace the verification; never set outside tests

export const googleAvailable = () => !!(override || client);

/** Verify a Google ID token and return its payload (throws when invalid). */
export async function verifyGoogleCredential(credential) {
  if (override) return override(credential);
  return (await client.verifyIdToken({ idToken: credential, audience: config.googleClientId })).getPayload();
}

export function setGoogleVerifierForTests(fn) {
  if (!config.isTest) throw new Error('setGoogleVerifierForTests is only for tests');
  override = fn;
}
