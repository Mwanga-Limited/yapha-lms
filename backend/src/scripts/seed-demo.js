// Demo data for a walkthrough: one Teacher, one Student and a published course.
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

async function upsertUser(db, email, name, role, extra = {}) {
  const hash = await bcrypt.hash(PASSWORD, config.bcryptRounds);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, role, email_verified_at, bio, expertise) VALUES ($1,$2,$3,$4, now(), $5, $6)
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [email, hash, name, role, extra.bio ?? null, extra.expertise ?? null]);
  return rows[0].id;
}

try {
  await tx(async (db) => {
    const teacherId = await upsertUser(db, 'teacher@example.com', 'Ngozi Adeyemi', 'teacher', { bio: 'Accountant who has trained market traders and small business owners for 12 years.', expertise: 'Bookkeeping' });
    await upsertUser(db, 'student@example.com', 'Tunde Bakare', 'student');
    const exists = await db.query(`SELECT 1 FROM courses WHERE title = $1`, ['Bookkeeping for Small Businesses']);
    if (exists.rowCount) return;
    const { rows: [c] } = await db.query(
      `INSERT INTO courses (teacher_id, title, summary, outline, category, level, language, description, status, published_at)
       VALUES ($1,$2,$3,$4,'Business','beginner','English',$5,'published', now()) RETURNING id`,
      [teacherId, 'Bookkeeping for Small Businesses', 'Track every naira with a simple weekly routine.',
        'Set up a cash book\nSeparate business and personal money\nRead your weekly numbers',
        'A practical introduction for traders, shop owners and freelancers. No accounting background needed.']);
    const { rows: [v] } = await db.query(
      `INSERT INTO course_versions (course_id, version_no, content, status, submitted_at, reviewed_at) VALUES ($1, 1, $2, 'approved', now(), now()) RETURNING id`, [c.id, content]);
    await db.query(`UPDATE courses SET live_version_id = $2 WHERE id = $1`, [c.id, v.id]);
    const { rows: [admin] } = await db.query(`SELECT id FROM users WHERE is_root`);
    if (admin) await db.query(`INSERT INTO course_reviews (course_id, version_id, version_no, admin_id, decision) VALUES ($1,$2,1,$3,'approved')`, [c.id, v.id, admin.id]);
  });
  console.log(`Demo data ready.\n  Teacher: teacher@example.com / ${PASSWORD} (2FA code arrives by email; with MAIL_TRANSPORT=console it prints in the API terminal)\n  Student: student@example.com / ${PASSWORD}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
