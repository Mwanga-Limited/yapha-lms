import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { audit } from './audit.js';
import { computeProgress } from './content.js';
import { emails } from './mailer.js';
import { notify } from './notify.js';

export async function loadCourseWithLive(db, courseId) {
  const { rows } = await db.query(
    `SELECT c.*, v.content AS live_content, u.name AS teacher_name
       FROM courses c LEFT JOIN course_versions v ON v.id = c.live_version_id
       JOIN users u ON u.id = c.teacher_id
      WHERE c.id = $1`, [courseId]);
  return rows[0] ?? null;
}

export async function activeEnrollment(db, userId, courseId, lock = false) {
  const { rows } = await db.query(
    `SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = 'active' ${lock ? 'FOR UPDATE' : ''}`,
    [userId, courseId]);
  return rows[0] ?? null;
}

export async function learnerState(db, enrollmentId) {
  const [lp, qs] = await Promise.all([
    db.query(`SELECT lesson_id, completed_at, position_sec FROM lesson_progress WHERE enrollment_id = $1`, [enrollmentId]),
    db.query(`SELECT * FROM quiz_states WHERE enrollment_id = $1`, [enrollmentId]),
  ]);
  const completed = new Set(lp.rows.filter((r) => r.completed_at).map((r) => r.lesson_id));
  const passed = new Set(qs.rows.filter((r) => r.passed_at).map((r) => r.quiz_id));
  return {
    completed, passed,
    positions: Object.fromEntries(lp.rows.map((r) => [r.lesson_id, r.position_sec])),
    quizStates: Object.fromEntries(qs.rows.map((r) => [r.quiz_id, r])),
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function certificateCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `EL-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * CC-01/CC-02: when every required lesson is done and every required quiz passed,
 * mark the enrolment complete and issue exactly one certificate.
 */
export async function checkCompletion(db, ctx, enrollment, course) {
  if (enrollment.completed_at) return null;
  const state = await learnerState(db, enrollment.id);
  const progress = computeProgress(course.live_content, state.completed, state.passed);
  if (!progress.ruleMet) return null;

  const { rows: [learner] } = await db.query(`SELECT * FROM users WHERE id = $1`, [enrollment.user_id]);
  if (learner.role !== 'student') return null;
  await db.query(`UPDATE enrollments SET completed_at = now() WHERE id = $1`, [enrollment.id]);
  let cert = null;
  for (let i = 0; i < 5 && !cert; i++) {
    const { rows } = await db.query(
      `INSERT INTO certificates (enrollment_id, user_id, course_id, code, recipient_name, course_title, teacher_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [enrollment.id, learner.id, course.id, certificateCode(), learner.name, course.title, course.teacher_name]);
    cert = rows[0] ?? null;
  }
  await audit(db, ctx, { action: 'certificate.issue', targetType: 'certificate', targetId: cert.id, newValues: { code: cert.code, course: course.title, learner: learner.email } });
  await notify(db, learner.id, { type: 'certificate', title: 'Certificate issued', body: `You completed ${course.title}. Your certificate is ready.`, link: '/dashboard' });
  ctx.after(() => emails.certificate(learner, cert));
  return cert;
}

/** CC-03 (Phase 2 hook): call when an enrolment is refunded or lost to a dispute. */
export async function revokeCertificateForEnrollment(db, ctx, enrollmentId, reason) {
  const { rows } = await db.query(
    `UPDATE certificates SET revoked_at = now(), revoke_reason = $2 WHERE enrollment_id = $1 AND revoked_at IS NULL RETURNING *`,
    [enrollmentId, reason]);
  if (rows[0]) await audit(db, ctx, { action: 'certificate.revoke', targetType: 'certificate', targetId: rows[0].id, newValues: { reason, automatic: true } });
  return rows[0] ?? null;
}

/** Render a certificate as a landscape A4 PDF. */
export function certificatePdf(cert) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate ${cert.code}` } });
  const W = doc.page.width, H = doc.page.height;
  const green = '#17324d', gold = '#e0b72a', ink = '#1c1c1c';

  doc.rect(0, 0, W, H).fill('#fbfbf8');
  doc.lineWidth(3).rect(28, 28, W - 56, H - 56).stroke(green);
  doc.lineWidth(0.8).rect(38, 38, W - 76, H - 76).stroke(gold);

  doc.fillColor(green).font('Helvetica-Bold').fontSize(13).text('E-LEARNING PLATFORM', 0, 78, { align: 'center', characterSpacing: 4 });
  doc.fillColor(ink).font('Times-Roman').fontSize(40).text('Certificate of Completion', 0, 112, { align: 'center' });
  doc.font('Helvetica').fontSize(13).fillColor('#555').text('This certifies that', 0, 182, { align: 'center' });
  doc.font('Times-Bold').fontSize(34).fillColor(green).text(cert.recipient_name, 60, 208, { align: 'center', width: W - 120 });
  doc.font('Helvetica').fontSize(13).fillColor('#555').text('has successfully completed the course', 0, 262, { align: 'center' });
  doc.font('Times-Italic').fontSize(24).fillColor(ink).text(cert.course_title, 80, 288, { align: 'center', width: W - 160 });

  const issued = new Date(cert.issued_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const y = H - 150;
  doc.lineWidth(0.8).strokeColor('#999');
  doc.moveTo(120, y).lineTo(320, y).stroke();
  doc.moveTo(W - 320, y).lineTo(W - 120, y).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(cert.teacher_name, 120, y + 8, { width: 200, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#666').text('Instructor', 120, y + 24, { width: 200, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(issued, W - 320, y + 8, { width: 200, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#666').text('Date issued', W - 320, y + 24, { width: 200, align: 'center' });

  doc.font('Helvetica').fontSize(10).fillColor('#555')
    .text(`Verification code: ${cert.code}   ·   Verify at ${config.appUrl}/verify/${cert.code}`, 0, H - 72, { align: 'center' });
  doc.end();
  return doc;
}
