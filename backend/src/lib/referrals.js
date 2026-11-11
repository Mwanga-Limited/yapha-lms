import { config } from '../config.js';
import { fail } from './errors.js';
import { currentTenant } from './tenant.js';

/*
 * Referrals: every teacher and student has a referral code, unique across the platform. A learner can enter
 * someone's code when they enrol in (pay for) a course; the enrolment then records whose code was used.
 */

/** Members who can refer others with their code. */
export const REFERRER_ROLES = ['student', 'teacher'];

/** A member's referral link: the organisation's courses, with their code filled in when the learner enrols. */
export const referralLink = (code, tenant = currentTenant()) => `${config.appUrl}/${tenant.slug}?ref=${encodeURIComponent(code)}`;

export const normaliseReferralCode = (code) => String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The referrer for an enrolment: an active teacher or student of this organisation with this code, who is not
 * the learner. An unknown or own code is an error the learner can fix before paying. No code → null.
 */
export async function findReferrer(db, code, learnerId) {
  const c = normaliseReferralCode(code);
  if (!c) return null;
  const { rows: [r] } = await db.query(
    `SELECT id, name FROM users WHERE referral_code = $1 AND is_active AND role = ANY($2)`, [c, REFERRER_ROLES]);
  if (!r) fail(400, 'This referral code is not valid. Check it, or leave it empty.', { code: 'INVALID_REFERRAL' });
  if (r.id === learnerId) fail(400, "You can't use your own referral code.", { code: 'OWN_REFERRAL' });
  return r;
}

/** b***@example.com: referrers see who used their code without the full email address (Admins see it in full). */
export function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(user.length - 1, 6)))}@${domain}`;
}

/** Enrolments made with these members' codes: who enrolled, in which course, and when (newest first). */
export async function referredEnrolments(db, referrerIds) {
  if (!referrerIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT e.id, e.referred_by, e.enrolled_at, u.name, u.email, c.id AS course_id, c.title AS course_title
       FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id
      WHERE e.referred_by = ANY($1) ORDER BY e.enrolled_at DESC`, [referrerIds]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.referred_by)) by.set(r.referred_by, []);
    by.get(r.referred_by).push(r);
  }
  return by;
}

/**
 * Referral codes are used per course, so referrals are shown per course: each course the code was used for,
 * how many enrolled in it with the code, and who (most enrolments first, then by title).
 */
export function byCourse(enrolments, email = (e) => e) {
  const groups = new Map();
  for (const r of enrolments) {
    if (!groups.has(r.course_id)) groups.set(r.course_id, { courseId: r.course_id, course: r.course_title, count: 0, referrals: [] });
    const g = groups.get(r.course_id);
    g.count += 1;
    g.referrals.push({ id: r.id, name: r.name, email: email(r.email), enrolledAt: r.enrolled_at });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.course.localeCompare(b.course));
}
