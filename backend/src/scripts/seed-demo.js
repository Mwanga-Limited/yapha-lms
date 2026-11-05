// Demo data for a walkthrough of multitenancy: two organisations, each with an Admin, a Teacher,
// a Student and a published course. The same student email exists in both, as two separate accounts.
// Usage: npm run seed:demo   (safe to run more than once)
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { pool, tx } from '../db.js';

const PASSWORD = 'Password123';
const content = {
  sections: [
    { id: 'intro', title: 'Getting started', items: [
      { id: 'welcome', kind: 'lesson', title: 'Welcome to the course', type: 'text', preview: true, durationMin: 3, videoUrl: '', fileId: null, fileName: '',
        body: 'Money that is not tracked disappears.\n\nIn this course you will set up a simple cash book, separate business and personal money, and read your numbers each week.' },
      { id: 'video1', kind: 'lesson', title: 'Why a cash book matters', type: 'video', preview: false, durationMin: 1, fileId: null, fileName: '',
        videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', body: 'Watch the short clip, then mark the lesson complete.' },
    ] },
    { id: 'practice', title: 'Putting it into practice', items: [
      { id: 'daily', kind: 'lesson', title: 'Your daily routine', type: 'text', preview: false, durationMin: 5, videoUrl: '', fileId: null, fileName: '',
        body: 'At the end of each day write down every sale and every expense.\n\nKeep receipts in one envelope per week. On Sunday, add up the week.' },
      { id: 'check', kind: 'quiz', title: 'Check your understanding', description: 'Three questions. You need 70% to pass.', questions: [
        { id: 'q1', type: 'single', prompt: 'When should you record a sale?', options: [{ id: 'a', text: 'The same day' }, { id: 'b', text: 'At the end of the year' }], correct: ['a'] },
        { id: 'q2', type: 'truefalse', prompt: 'Business and personal money should be kept separate.', options: [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }], correct: ['true'] },
        { id: 'q3', type: 'multi', prompt: 'Which of these belong in the cash book?', options: [{ id: 'x', text: 'Sales' }, { id: 'y', text: 'Expenses' }, { id: 'z', text: 'Rumours' }], correct: ['x', 'y'] },
      ] },
    ] },
  ],
  completion: { lessons: ['welcome', 'video1', 'daily'], quizzes: ['check'] },
};


const ORGS = [
  { slug: 'acme', name: 'Acme Academy', course: 'Bookkeeping for Small Businesses',
    settings: { branding: { displayName: '', logoFileId: null, accentColor: '#F2CC3D' }, quiz: { passMark: 70, maxAttempts: 3, lockHours: 24 },
      access: { signup: 'open', allowedDomains: [] }, auth: { google: true, studentMfa: false } } },
  { slug: 'globex', name: 'Globex Training', course: 'Customer Service Essentials',
    settings: { branding: { displayName: 'Globex Learning', logoFileId: null, accentColor: '#7FD1AE' }, quiz: { passMark: 80, maxAttempts: 2, lockHours: 12 },
      access: { signup: 'open', allowedDomains: [] }, auth: { google: true, studentMfa: false } } },
];

async function upsertUser(db, tenantId, email, name, role, extra = {}) {
  const found = await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2`, [tenantId, email]);
  if (found.rows[0]) return found.rows[0].id;
  const hash = await bcrypt.hash(PASSWORD, config.bcryptRounds);
  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, is_root, email_verified_at, bio, expertise)
     VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8) RETURNING id`,
    [tenantId, email, hash, name, role, !!extra.isRoot, extra.bio ?? null, extra.expertise ?? null]);
  return rows[0].id;
}

try {
  for (const o of ORGS) {
    await tx(async (db) => {
      let { rows: [t] } = await db.query(`SELECT * FROM tenants WHERE slug = $1`, [o.slug]);
      if (!t) ({ rows: [t] } = await db.query(`INSERT INTO tenants (slug, name, settings) VALUES ($1,$2,$3) RETURNING *`, [o.slug, o.name, o.settings]));
      const hasRoot = (await db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND is_root`, [t.id])).rowCount > 0;
      const adminId = await upsertUser(db, t.id, `admin@${o.slug}.example.com`, `${o.name} Admin`, 'admin', { isRoot: !hasRoot });
      const teacherId = await upsertUser(db, t.id, 'teacher@example.com', o.slug === 'acme' ? 'Ngozi Adeyemi' : 'Kemi Lawal', 'teacher',
        { bio: 'Practitioner and trainer with over ten years of experience.', expertise: o.slug === 'acme' ? 'Bookkeeping' : 'Customer service' });
      await upsertUser(db, t.id, 'student@example.com', o.slug === 'acme' ? 'Tunde Bakare' : 'Tunde Bakare (Globex)', 'student');
      if ((await db.query(`SELECT 1 FROM courses WHERE tenant_id = $1 AND title = $2`, [t.id, o.course])).rowCount) return;
      const { rows: [c] } = await db.query(
        `INSERT INTO courses (tenant_id, teacher_id, title, summary, outline, category, level, language, description, status, published_at)
         VALUES ($1,$2,$3,$4,$5,'Business','beginner','English',$6,'published', now()) RETURNING id`,
        [t.id, teacherId, o.course, `A short, practical course from ${o.name}.`, 'Set up a cash book\nSeparate business and personal money\nRead your weekly numbers',
          'A practical introduction. No background needed.']);
      const { rows: [v] } = await db.query(
        `INSERT INTO course_versions (tenant_id, course_id, version_no, content, status, submitted_at, reviewed_at) VALUES ($1,$2, 1, $3, 'approved', now(), now()) RETURNING id`,
        [t.id, c.id, content]);
      await db.query(`UPDATE courses SET live_version_id = $2 WHERE id = $1`, [c.id, v.id]);
      await db.query(`INSERT INTO course_reviews (tenant_id, course_id, version_id, version_no, admin_id, decision) VALUES ($1,$2,$3,1,$4,'approved')`, [t.id, c.id, v.id, adminId]);
    });
  }
  console.log(`Demo data ready. Every demo password is ${PASSWORD}.
  ${config.appUrl}/t/acme     Acme Academy    (open sign-up, 70% pass mark, 3 attempts)
     admin@acme.example.com, teacher@example.com, student@example.com
  ${config.appUrl}/t/globex   Globex Training (open sign-up, 80% pass mark, 2 attempts)
     admin@globex.example.com, teacher@example.com, student@example.com
  The same teacher/student emails are separate accounts in each organisation.
  Admin and Teacher sign-in codes arrive by email (printed in the API terminal with MAIL_TRANSPORT=console).`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
