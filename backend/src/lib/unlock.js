// Course unlocking: when an enrolled learner can open each section of a course.
//
// Completion-based (every course): Section 1 is open; each later section opens when every lesson in the section before it
// is complete (under its own completion rules, e.g. a video must be watched) and every quiz in it is passed.
//
// Time-based (optional, per course): the whole course opens a set number of hours after the learner enrolled
// (e.g. 48 hours, or 7 days = 168). Until then no section is open; after that, sections unlock in order as above.
// The delay lives in the course content (content.unlock.afterHours), so a teacher's change goes through review with the
// rest of the course and only takes effect when an Admin approves it. An Admin can also change it on the live course.
//
// Free preview lessons are always open: anyone can open them from the course page anyway.
import { z } from 'zod';
import { fail } from './errors.js';

export const MAX_UNLOCK_HOURS = 365 * 24;

/** { afterHours: null } = no delay; { afterHours: 48 } = the course opens 48 hours after enrolment. */
export const unlockSchema = z.object({
  afterHours: z.number().int('Use whole hours').min(1, 'The delay must be at least 1 hour').max(MAX_UNLOCK_HOURS, 'The delay must be under a year').nullable().default(null),
}).default({ afterHours: null });

/** A course's time-based setting (content saved before this feature has none: no delay). */
export const unlockOf = (content) => ({ afterHours: Number.isInteger(content?.unlock?.afterHours) && content.unlock.afterHours > 0 ? content.unlock.afterHours : null });

const sectionDone = (section, st) => section.items.every((it) => (it.kind === 'lesson' ? st.completed.has(it.id) : st.passed.has(it.id)));

/** When the course opens for this learner (null = straight away). */
export function opensAt(content, enrollment) {
  const { afterHours } = unlockOf(content);
  return afterHours ? new Date(new Date(enrollment.enrolled_at).getTime() + afterHours * 3600 * 1000) : null;
}

/**
 * For each section, whether this learner can open it now:
 * { open: true } | { open: false, reason: 'time', opensAt } | { open: false, reason: 'completion', after: '<previous section title>' }.
 * st = learnerState(...) (completed lessons, passed quizzes).
 */
export function sectionAccess(content, enrollment, st, now = new Date()) {
  const sections = content?.sections ?? [];
  const at = opensAt(content, enrollment);
  if (at && now < at) return sections.map(() => ({ open: false, reason: 'time', opensAt: at.toISOString() }));
  let previousOpenAndDone = true;
  let previous = null;
  return sections.map((s, i) => {
    const open = i === 0 || previousOpenAndDone;
    const access = open ? { open: true } : { open: false, reason: 'completion', after: previous.title || `Section ${i}` };
    previousOpenAndDone = open && sectionDone(s, st);
    previous = s;
    return access;
  });
}

/** Refuse to open a lesson or quiz in a section that is still locked for this learner (the player shows why). */
export function requireUnlocked(content, enrollment, st, itemId) {
  const sections = content?.sections ?? [];
  const i = sections.findIndex((s) => s.items.some((it) => it.id === itemId));
  if (i < 0) return;
  const item = sections[i].items.find((it) => it.id === itemId);
  if (item.kind === 'lesson' && item.preview) return;
  const access = sectionAccess(content, enrollment, st)[i];
  if (access.open) return;
  if (access.reason === 'time') fail(423, `This course opens on ${new Date(access.opensAt).toUTCString()}`, { code: 'COURSE_LOCKED', opensAt: access.opensAt });
  fail(423, `Complete "${access.after}" to unlock this section`, { code: 'SECTION_LOCKED', after: access.after });
}
