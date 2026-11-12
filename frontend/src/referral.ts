// Referral codes from links like /yapha/register?ref=AB3K7Q2M. The code is remembered (per organisation) when someone
// arrives through a link, so it still applies if they look around before signing up, or sign up with Google.
import { getTenantSlug } from './api';

const key = () => `referral:${getTenantSlug() ?? ''}`;

export function rememberReferral(code: string | null) {
  const c = (code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!c) return;
  try { localStorage.setItem(key(), c); } catch { /* storage unavailable: the code still works from the link itself */ }
}
export function rememberedReferral(): string {
  try { return localStorage.getItem(key()) ?? ''; } catch { return ''; }
}
export function forgetReferral() {
  try { localStorage.removeItem(key()); } catch { /* nothing to forget */ }
}
