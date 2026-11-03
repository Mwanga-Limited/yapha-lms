import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { asTenant, db, query, runInContext, tx } from '../db.js';
import { actionEndpoint, email, password, reqStr } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { emails } from '../lib/mailer.js';
import { RESERVED_SLUGS, SLUG_RE, defaultSettings } from '../lib/tenant.js';
import { issueUserToken } from '../lib/tokens.js';

/*
 * POST /api/organisations — public self-service registration of a new organisation.
 * Whoever registers becomes the organisation's first Admin (AD-01: one per organisation, protected by AD-04).
 * Runs at platform level (no organisation yet); the first Admin is created inside the new organisation.
 * Turn it off with ORG_SIGNUP=closed. Registrations are rate limited per IP (see routes/index.js).
 */
const slug = z.string().trim().toLowerCase().regex(SLUG_RE, 'Use 2–40 lowercase letters, numbers and dashes (e.g. acme-academy)');

async function addressProblem(s) {
  if (RESERVED_SLUGS.has(s)) return `"${s}" is reserved. Choose another web address.`;
  const { rowCount } = await query(`SELECT 1 FROM tenants WHERE slug = $1`, [s]);
  return rowCount ? 'Another organisation already uses this web address' : null;
}

function requireOpen() {
  if (!config.orgSignupOpen) fail(403, 'New organisations cannot register right now. Contact the platform team.', { code: 'ORG_SIGNUP_CLOSED' });
}

export const organisationRoutes = actionEndpoint({
  /** Whether self-registration is open (the landing page shows or hides "Register your organisation"). */
  info: { auth: 'public', run: async () => ({ signupOpen: config.orgSignupOpen }) },

  /** Live check while typing the web address. */
  checkAddress: {
    auth: 'public',
    schema: z.object({ slug: z.string().trim().toLowerCase().max(60) }),
    run: async ({ data }) => {
      if (!SLUG_RE.test(data.slug)) return { available: false, reason: 'Use 2–40 lowercase letters, numbers and dashes, starting and ending with a letter or number' };
      const problem = await addressProblem(data.slug);
      return { available: !problem, reason: problem };
    },
  },

  register: {
    auth: 'public',
    schema: z.object({
      organisationName: reqStr(120),
      slug,
      name: reqStr(120),
      email,
      password,
    }),
    run: async (ctx) => {
      requireOpen();
      const d = ctx.data;
      const hash = await bcrypt.hash(d.password, config.bcryptRounds);
      const { tenant, admin } = await tx(async () => {
        const problem = await addressProblem(d.slug);
        if (problem) fail(problem.startsWith('Another') ? 409 : 400, problem);
        const { rows: [t] } = await query(`INSERT INTO tenants (slug, name, settings) VALUES ($1,$2,$3) RETURNING *`,
          [d.slug, d.organisationName, defaultSettings()]);
        await audit({ query }, ctx, { action: 'platform.tenant_register', targetType: 'tenant', targetId: t.id,
          newValues: { name: t.name, slug: t.slug, adminEmail: d.email }, actor: null });
        // The person registering becomes the first Admin, inside the new organisation (row-level security applies).
        const u = await asTenant(t, async () => {
          const { rows: [row] } = await query(
            `INSERT INTO users (tenant_id, email, password_hash, name, role, is_root) VALUES ($1,$2,$3,$4,'admin',true) RETURNING *`,
            [t.id, d.email, hash, d.name]);
          await audit(db, ctx, { action: 'tenant.register', targetType: 'tenant', targetId: t.id,
            newValues: { name: t.name, slug: t.slug, firstAdmin: row.email }, actor: row });
          const token = await issueUserToken(db, row.id, 'verify_email', 24 * 60);
          ctx.after(() => runInContext({ tenant: t }, () => emails.verify(row, token)));
          return row;
        });
        const { rows: supers } = await query(`SELECT email FROM users WHERE tenant_id IS NULL AND role = 'superadmin' AND is_active`);
        ctx.after(() => Promise.all(supers.map((s) => emails.organisationRegistered(s.email, t, u))));
        return { tenant: t, admin: u };
      });
      return {
        organisation: { id: tenant.id, slug: tenant.slug, name: tenant.name, url: `/${tenant.slug}` },
        admin: { email: admin.email, memberCode: admin.member_code },
      };
    },
  },
});
