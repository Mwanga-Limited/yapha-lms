import { z } from 'zod';
import { currentScope, withScope } from '../db.js';

/*
 * Per-organisation configuration. Same business rules for everyone; these values are what each
 * organisation may change. Defaults reproduce the original Phase 1 rules (70% pass mark, 3 attempts, 24h lock).
 */
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #F2CC3D');
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Enter a domain like acme.com');

export const settingsSchema = z.object({
  branding: z.object({
    displayName: z.string().trim().max(80).default(''),          // shown instead of the organisation name when set
    logoFileId: z.string().uuid().nullable().default(null),
    accentColor: hex.default('#F2CC3D'),
  }).prefault({}),
  quiz: z.object({
    passMark: z.number().int().min(1).max(100).default(70),      // QZ-01
    maxAttempts: z.number().int().min(1).max(20).default(3),     // QZ-01
    lockHours: z.number().int().min(1).max(720).default(24),     // QZ-02
  }).prefault({}),
  access: z.object({
    signup: z.enum(['open', 'invite']).default('open'),          // invite: only Admin invitations create accounts
    allowedDomains: z.array(domain).max(50).default([]),        // empty = any email domain
  }).prefault({}),
  auth: z.object({
    google: z.boolean().default(true),                           // Google sign-in (needs GOOGLE_CLIENT_ID on the server)
    studentMfa: z.boolean().default(false),                      // require two-step sign-in for students too
  }).prefault({}),
});

export const defaultSettings = () => settingsSchema.parse({});
export const settingsOf = (tenant) => settingsSchema.parse(tenant?.settings ?? {});
export const tenantName = (tenant) => settingsOf(tenant).branding.displayName || tenant?.name || 'E-Learning';

/** The current request's organisation (set by the tenant router). */
export const currentTenant = () => currentScope()?.tenant ?? null;

/** API path prefix for the current organisation, used to build file and certificate URLs. */
export const apiBase = (tenant = currentTenant()) => (tenant ? `/api/t/${tenant.slug}` : '/api/platform');

/** Settings that the organisation's public pages need (no secrets). */
export function publicTenant(tenant) {
  const s = settingsOf(tenant);
  return {
    id: tenant.id, slug: tenant.slug, name: tenantName(tenant), legalName: tenant.name, status: tenant.status,
    branding: { accentColor: s.branding.accentColor, logoUrl: s.branding.logoFileId ? `${apiBase(tenant)}/files/${s.branding.logoFileId}` : null },
    quiz: s.quiz,
    access: { signup: s.access.signup, allowedDomains: s.access.allowedDomains },
    auth: s.auth,
  };
}

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED_SLUGS = new Set(['api', 'platform', 't', 'admin', 'www', 'static', 'assets', 'app']);

/** Look a tenant up by slug (a platform-level read, done before the tenant scope opens). */
export async function findTenantBySlug(slug) {
  if (!SLUG_RE.test(slug)) return null;
  return withScope({ bypass: true }, async () => {
    const { rows } = await currentScope().client.query(`SELECT * FROM tenants WHERE slug = $1`, [slug]);
    return rows[0] ?? null;
  });
}

/** Is this email allowed to join the organisation? */
export function emailAllowed(tenant, email) {
  const { allowedDomains } = settingsOf(tenant).access;
  if (!allowedDomains.length) return true;
  const d = String(email).split('@')[1]?.toLowerCase() ?? '';
  return allowedDomains.some((a) => d === a || d.endsWith(`.${a}`));
}
