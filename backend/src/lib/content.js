import { currentTenant, settingsOf } from './tenant.js';
import { z } from 'zod';

/*
 * Course content stored per version (JSONB):
 * {
 *   sections: [{ id, title, items: [Lesson | Quiz] }],
 *   completion: { lessons: [lessonId], quizzes: [quizId] }      // teacher-defined completion rule
 * }
 * Lesson: { id, kind:'lesson', title, type:'video'|'text'|'file', body, videoUrl, fileId, fileName, preview, durationMin }
 * Quiz:   { id, kind:'quiz', title, description, questions: [{ id, type:'single'|'multi'|'truefalse', prompt, options:[{id,text}], correct:[optionId] }] }
 * Item ids are stable across versions so learner progress survives re-approval.
 */

// Quiz rules (QZ-01/QZ-02) are per organisation: see settings.quiz in lib/tenant.js.
// Defaults: 70% pass mark, 3 attempts, then a 24-hour lock.
export const quizRules = () => settingsOf(currentTenant()).quiz;

const itemId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');
const text = (max) => z.string().max(max).default('');

const option = z.object({ id: itemId, text: text(500) });
const question = z.object({
  id: itemId,
  type: z.enum(['single', 'multi', 'truefalse']),
  prompt: text(2000),
  options: z.array(option).max(10).default([]),
  correct: z.array(itemId).max(10).default([]),
});
const lesson = z.object({
  id: itemId, kind: z.literal('lesson'), title: text(200),
  type: z.enum(['video', 'text', 'file']),
  body: text(100_000),
  videoUrl: text(1000),
  fileId: z.string().uuid().nullable().default(null),
  fileName: text(255),
  preview: z.boolean().default(false),
  durationMin: z.number().min(0).max(10_000).nullable().default(null),
});
const quiz = z.object({
  id: itemId, kind: z.literal('quiz'), title: text(200), description: text(2000),
  questions: z.array(question).max(100).default([]),
});
const section = z.object({ id: itemId, title: text(200), items: z.array(z.discriminatedUnion('kind', [lesson, quiz])).max(200).default([]) });

/** Lenient schema: drafts may be incomplete. Strict checks happen on submit (CR-01). */
export const contentSchema = z.object({
  sections: z.array(section).max(100).default([]),
  completion: z.object({ lessons: z.array(itemId).default([]), quizzes: z.array(itemId).default([]) }).default({ lessons: [], quizzes: [] }),
});

export const emptyContent = () => ({ sections: [], completion: { lessons: [], quizzes: [] } });

export const flatItems = (content) => (content?.sections ?? []).flatMap((s) => s.items.map((it) => ({ ...it, sectionId: s.id, sectionTitle: s.title })));
export const lessonsOf = (c) => flatItems(c).filter((i) => i.kind === 'lesson');
export const quizzesOf = (c) => flatItems(c).filter((i) => i.kind === 'quiz');
export const findItem = (c, id, kind) => flatItems(c).find((i) => i.id === id && (!kind || i.kind === kind)) ?? null;

/** Normalise and sanity-check content on save (ids unique, true/false options fixed, rule ids exist). */
export function normaliseContent(raw) {
  const c = contentSchema.parse(raw);
  const seen = new Set();
  for (const s of c.sections) {
    if (seen.has(s.id)) throw new Error(`Duplicate id ${s.id}`);
    seen.add(s.id);
    for (const it of s.items) {
      if (seen.has(it.id)) throw new Error(`Duplicate id ${it.id}`);
      seen.add(it.id);
      if (it.kind === 'quiz') {
        for (const q of it.questions) {
          if (q.type === 'truefalse') q.options = [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];
          const ids = new Set(q.options.map((o) => o.id));
          q.correct = [...new Set(q.correct)].filter((x) => ids.has(x));
        }
      }
    }
  }
  const lessonIds = new Set(lessonsOf(c).map((l) => l.id));
  const quizIds = new Set(quizzesOf(c).map((q) => q.id));
  c.completion.lessons = [...new Set(c.completion.lessons)].filter((x) => lessonIds.has(x));
  c.completion.quizzes = [...new Set(c.completion.quizzes)].filter((x) => quizIds.has(x));
  return c;
}

/** CR-01 and content completeness. Returns a list of human-readable problems (empty = OK to submit). */
export function submissionProblems(course, content) {
  const p = [];
  if (!course.title?.trim()) p.push('Add a course title');
  if (!course.summary?.trim()) p.push('Add a summary');
  if (!course.category?.trim()) p.push('Choose a category');
  if (!course.outline?.trim()) p.push('Add a course outline (CR-01)');
  const lessons = lessonsOf(content);
  const quizzes = quizzesOf(content);
  if (!lessons.length) p.push('Add at least one lesson (CR-01)');
  if (!quizzes.length) p.push('Add at least one quiz (CR-01)');
  if (!content.completion.lessons.length && !content.completion.quizzes.length) p.push('Set a completion rule: mark which lessons and quizzes are required (CR-01)');
  for (const s of content.sections) if (!s.title.trim()) p.push('Every section needs a title');
  for (const s of content.sections) if (!s.items.length) p.push(`Section "${s.title || 'untitled'}" is empty`);
  for (const l of lessons) {
    const name = `Lesson "${l.title || 'untitled'}"`;
    if (!l.title.trim()) p.push(`${name}: add a title`);
    if (l.type === 'video' && !l.fileId && !/^https?:\/\//.test(l.videoUrl)) p.push(`${name}: upload a video or add a video link`);
    if (l.type === 'file' && !l.fileId) p.push(`${name}: upload a file`);
    if (l.type === 'text' && !l.body.trim()) p.push(`${name}: add the lesson text`);
  }
  for (const q of quizzes) {
    const name = `Quiz "${q.title || 'untitled'}"`;
    if (!q.title.trim()) p.push(`${name}: add a title`);
    if (!q.questions.length) p.push(`${name}: add at least one question`);
    q.questions.forEach((qq, i) => {
      const n = `${name}, question ${i + 1}`;
      if (!qq.prompt.trim()) p.push(`${n}: add the question text`);
      if (qq.options.length < 2) p.push(`${n}: add at least two options`);
      if (qq.options.some((o) => !o.text.trim())) p.push(`${n}: an option is empty`);
      if (!qq.correct.length) p.push(`${n}: mark the correct answer`);
      if (qq.type !== 'multi' && qq.correct.length > 1) p.push(`${n}: only one answer can be correct`);
    });
  }
  return [...new Set(p)];
}

/** Content safe for learners: no correct answers. */
export function learnerQuiz(quiz) {
  return {
    id: quiz.id, title: quiz.title, description: quiz.description,
    questions: quiz.questions.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options })),
  };
}

/** Outline for catalog / player: titles and types only. */
export function outlineOf(content) {
  return (content?.sections ?? []).map((s) => ({
    id: s.id, title: s.title,
    items: s.items.map((it) => it.kind === 'lesson'
      ? { id: it.id, kind: 'lesson', title: it.title, type: it.type, preview: it.preview, durationMin: it.durationMin,
          required: content.completion.lessons.includes(it.id) }
      : { id: it.id, kind: 'quiz', title: it.title, questionCount: it.questions.length,
          required: content.completion.quizzes.includes(it.id) }),
  }));
}

/** Auto-grade (multi-select must match exactly). */
export function gradeQuiz(quiz, answers) {
  const results = quiz.questions.map((q) => {
    const given = [...new Set((answers?.[q.id] ?? []).map(String))].sort();
    const want = [...q.correct].sort();
    return { questionId: q.id, correct: given.length === want.length && given.every((g, i) => g === want[i]) };
  });
  const correct = results.filter((r) => r.correct).length;
  const score = quiz.questions.length ? Math.round((correct / quiz.questions.length) * 10000) / 100 : 0;
  return { score, passed: score >= quizRules().passMark, results, correct, total: quiz.questions.length };
}

/** Progress for a course: all lessons + quizzes count toward the bar; the rule decides completion (CC-01). */
export function computeProgress(content, completedLessons, passedQuizzes) {
  const items = flatItems(content);
  const done = items.filter((i) => (i.kind === 'lesson' ? completedLessons.has(i.id) : passedQuizzes.has(i.id))).length;
  const rule = content.completion;
  const ruleMet = (rule.lessons.length + rule.quizzes.length) > 0
    && rule.lessons.every((id) => completedLessons.has(id))
    && rule.quizzes.every((id) => passedQuizzes.has(id));
  return { total: items.length, done, percent: items.length ? Math.round((done / items.length) * 100) : 0, ruleMet };
}
