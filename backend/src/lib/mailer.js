import nodemailer from 'nodemailer';
import { config } from '../config.js';

/** Emails sent while MAIL_TRANSPORT=memory (used by the tests). */
export const outbox = [];

let transporter = null;
if (config.mail.transport === 'smtp') {
  transporter = nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, paragraphs, action) {
  const btn = action
    ? `<p style="margin:28px 0"><a href="${esc(action.url)}" style="background:#17324d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p>
       <p style="color:#6b6b6b;font-size:13px">Or open this link: ${esc(action.url)}</p>`
    : '';
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;padding:24px;color:#1c1c1c">
    <h2 style="color:#17324d;margin-top:0">${esc(title)}</h2>
    ${paragraphs.map((p) => `<p style="font-family:Arial,sans-serif;line-height:1.5">${esc(p)}</p>`).join('')}
    ${btn}
    <hr style="border:none;border-top:1px solid #e5e1d8;margin-top:32px"/>
    <p style="font-family:Arial,sans-serif;color:#8a8a8a;font-size:12px">E-Learning Platform</p></div>`;
}

export async function sendMail({ to, subject, title, paragraphs = [], action }) {
  const text = [title, '', ...paragraphs, action ? `\n${action.label}: ${action.url}` : ''].join('\n');
  const msg = { from: config.mail.from, to, subject, text, html: layout(title || subject, paragraphs, action) };
  try {
    if (config.mail.transport === 'smtp') await transporter.sendMail(msg);
    else if (config.mail.transport === 'memory') outbox.push(msg);
    else console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
  } catch (err) {
    console.error('[mail] failed to send', subject, 'to', to, err.message);
  }
}

const url = (p) => `${config.appUrl}${p}`;

export const emails = {
  verify: (u, token) => sendMail({ to: u.email, subject: 'Verify your email', title: `Welcome, ${u.name}`,
    paragraphs: ['Please confirm your email address. You need a verified email to enrol in or submit courses.', 'This link expires in 24 hours.'],
    action: { label: 'Verify email', url: url(`/verify-email?token=${token}`) } }),
  reset: (u, token) => sendMail({ to: u.email, subject: 'Reset your password', title: 'Password reset',
    paragraphs: ['Someone asked to reset the password for your account. If this was not you, ignore this email.', 'This link expires in 60 minutes.'],
    action: { label: 'Choose a new password', url: url(`/reset-password?token=${token}`) } }),
  mfaCode: (u, code) => sendMail({ to: u.email, subject: `Your sign-in code: ${code}`, title: 'Your sign-in code',
    paragraphs: [`Your two-factor sign-in code is ${code}.`, 'It expires in 10 minutes. Never share it with anyone.'] }),
  courseDecision: (u, course, approved, reason) => sendMail({ to: u.email,
    subject: approved ? `Approved: ${course.title}` : `Changes requested: ${course.title}`,
    title: approved ? 'Your course was approved' : 'Your course needs changes',
    paragraphs: approved
      ? [`"${course.title}" was approved by an administrator.`, course.live ? 'The updated content is now live.' : 'You can now publish it to the catalog.']
      : [`"${course.title}" was not approved.`, `Reason: ${reason}`, 'Make the changes and resubmit for review.'],
    action: { label: 'Open course', url: url(`/teach/courses/${course.id}`) } }),
  applicationDecision: (u, approved, reason) => sendMail({ to: u.email,
    subject: approved ? 'Your instructor application was approved' : 'Your instructor application',
    title: approved ? 'You are now a Teacher' : 'Instructor application declined',
    paragraphs: approved
      ? ['Your instructor application was approved. Sign in again to start creating courses.', 'Teachers must sign in with two-factor authentication.']
      : ['Unfortunately your instructor application was declined.', `Reason: ${reason}`],
    action: { label: 'Go to Teach', url: url('/teach') } }),
  enrolled: (u, course) => sendMail({ to: u.email, subject: `You're enrolled: ${course.title}`, title: 'Enrolment confirmed',
    paragraphs: [`You are enrolled in "${course.title}". Happy learning!`],
    action: { label: 'Start learning', url: url(`/learn/${course.id}`) } }),
  quizResult: (u, course, quiz, score, passed, state) => sendMail({ to: u.email,
    subject: `Quiz result: ${quiz.title} — ${passed ? 'passed' : 'not passed'}`, title: passed ? 'Quiz passed' : 'Quiz not passed',
    paragraphs: [`You scored ${score}% on "${quiz.title}" in "${course.title}". The pass mark is 70%.`,
      passed ? 'Well done.' : state.lockedUntil ? `You have used all 3 attempts. The quiz unlocks at ${new Date(state.lockedUntil).toUTCString()}.` : `Attempts left: ${state.attemptsLeft}.`],
    action: { label: 'Back to course', url: url(`/learn/${course.id}`) } }),
  certificate: (u, cert) => sendMail({ to: u.email, subject: `Certificate issued: ${cert.course_title}`, title: 'Congratulations!',
    paragraphs: [`You completed "${cert.course_title}". Your certificate verification code is ${cert.code}.`],
    action: { label: 'View certificate', url: url(`/verify/${cert.code}`) } }),
};
