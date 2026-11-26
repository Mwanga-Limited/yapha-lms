import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { agent, call, loginRoot, makeTeacher, pool, publishedCourse, sampleContent } from './helpers.js';

let root, teacher, other;
before(async () => {
  const { resetDb } = await import('./helpers.js');
  await resetDb();
  root = await loginRoot();
  teacher = (await makeTeacher('Editing Teacher', root)).a;
  other = (await makeTeacher('Other Teacher', root)).a;
});
after(async () => { await pool.end(); });

const details = (title, over = {}) => ({ title, summary: 'Learn algebra', category: 'Mathematics', outline: 'Variables, equations', level: 'beginner', ...over });
const live = async (id) => (await call(agent(), 'courses', 'detail', { id }).expect(200)).body;
const queued = async (id) => (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
const auditFor = async (id, action) => (await pool.query(
  `SELECT * FROM audit_logs WHERE target_id = $1 AND action = $2 ORDER BY created_at`, [id, action])).rows;

describe('Editing a published course', () => {
  test("the teacher's changes to the details wait for an Admin's approval; learners keep the live details", async () => {
    const id = await publishedCourse(teacher, root, 'Algebra Live');
    const r = await call(teacher, 'courses', 'updateMeta', { id, ...details('Algebra Live', { summary: 'A better summary', level: 'intermediate' }) }).expect(200);
    assert.equal(r.body.awaitingApproval, true);
    assert.equal(r.body.course.summary, 'Learn algebra', 'the course itself is unchanged');
    assert.equal(r.body.details.summary, 'A better summary');

    // Learners still see the live details; the course stays published.
    let d = await live(id);
    assert.equal(d.course.summary, 'Learn algebra');
    assert.equal(d.course.level, 'beginner');
    assert.equal(d.course.status, 'published');

    // The editor shows the pending details on the revision, which was started automatically.
    const g = (await call(teacher, 'courses', 'get', { id })).body;
    assert.equal(g.draft.status, 'draft');
    assert.equal(g.draft.details.summary, 'A better summary');
    assert.equal(g.course.summary, 'Learn algebra');

    await call(teacher, 'courses', 'submit', { id }).expect(200);
    const q = await queued(id);
    assert.equal(q.isRevision, true);
    assert.equal(q.detailsChanged, true);
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Algebra Live', { summary: 'Sneaky change' }) }).expect(409);   // locked while reviewed
    d = await live(id);
    assert.equal(d.course.summary, 'Learn algebra', 'still not live while in review');

    await call(root, 'admin', 'approveCourse', { versionId: q.versionId }).expect(200);
    d = await live(id);
    assert.equal(d.course.summary, 'A better summary');
    assert.equal(d.course.level, 'intermediate');
    assert.equal(d.course.status, 'published');
    assert.equal((await call(teacher, 'courses', 'get', { id })).body.draft, null);
  });

  test('a rejected edit never goes live; the teacher can fix it and resubmit', async () => {
    const id = await publishedCourse(teacher, root, 'Geometry Live');
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Geometry LIVE!!!') }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    await call(root, 'admin', 'rejectCourse', { versionId: (await queued(id)).versionId, reason: 'Please keep the original title style' }).expect(200);
    assert.equal((await live(id)).course.title, 'Geometry Live');
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Geometry Live: Shapes') }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    await call(root, 'admin', 'approveCourse', { versionId: (await queued(id)).versionId }).expect(200);
    const d = await live(id);
    assert.equal(d.course.title, 'Geometry Live: Shapes');
    assert.equal(d.course.slug, 'geometry-live', 'the web address never changes once published');
  });

  test('details and lessons changed together go live together on approval', async () => {
    const id = await publishedCourse(teacher, root, 'Statistics Live');
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Statistics Live', { outline: 'Mean, median, mode' }) }).expect(200);
    const changed = sampleContent();
    changed.sections[0].items[0].title = 'Welcome to statistics';
    await call(teacher, 'courses', 'saveContent', { id, content: changed }).expect(200);   // same revision
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    let d = await live(id);
    assert.equal(d.outline[0].items[0].title, 'Welcome');
    assert.equal(d.course.outline, 'Variables, equations');
    await call(root, 'admin', 'approveCourse', { versionId: (await queued(id)).versionId }).expect(200);
    d = await live(id);
    assert.equal(d.outline[0].items[0].title, 'Welcome to statistics');
    assert.equal(d.course.outline, 'Mean, median, mode');
  });

  test("an Admin can edit a teacher's published course; it still needs approval, and is audited as the Admin", async () => {
    const id = await publishedCourse(teacher, root, 'Admin Edited');
    await call(root, 'courses', 'updateMeta', { id, ...details('Admin Edited', { description: 'Rewritten by the Admin' }) }).expect(200);
    const changed = sampleContent();
    changed.sections[0].title = 'Updated by the Admin';
    await call(root, 'courses', 'saveContent', { id, content: changed }).expect(200);
    assert.equal((await live(id)).course.description, '', 'not live before approval');
    await call(root, 'courses', 'submit', { id }).expect(200);
    await call(root, 'admin', 'approveCourse', { versionId: (await queued(id)).versionId }).expect(200);
    const d = await live(id);
    assert.equal(d.course.description, 'Rewritten by the Admin');
    assert.equal(d.outline[0].title, 'Updated by the Admin');

    const [edit] = await auditFor(id, 'course.edit');
    assert.equal(edit.actor_role, 'admin');
    assert.deepEqual(edit.old_values, { description: '' });
    assert.equal(edit.new_values.description, 'Rewritten by the Admin');
    assert.equal(edit.new_values.awaitingApproval, true);
    assert.equal((await auditFor(id, 'course.content_saved')).at(-1).actor_role, 'admin');
    assert.equal((await auditFor(id, 'course.approve')).at(-1).new_values.details.description, 'Rewritten by the Admin');
  });

  test("every edit is in the audit log with what changed; another teacher can't edit", async () => {
    const id = await publishedCourse(teacher, root, 'Audited Course');
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Audited Course', { category: 'Maths' }) }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Audited Course', { category: 'Maths', language: 'Yoruba' }) }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Audited Course', { category: 'Maths', language: 'Yoruba' }) }).expect(200);   // no change: no event
    const edits = await auditFor(id, 'course.edit');
    assert.equal(edits.length, 2);
    assert.deepEqual(edits[0].old_values, { category: 'Mathematics' });
    assert.deepEqual(edits[1].old_values, { language: 'English' });
    assert.equal(edits[1].new_values.language, 'Yoruba');
    assert.equal(edits[1].actor_role, 'teacher');
    assert.equal((await auditFor(id, 'course.revision_start')).length, 1);

    await call(other, 'courses', 'updateMeta', { id, ...details('Stolen') }).expect(403);
    await call(other, 'courses', 'startRevision', { id }).expect(403);
    await call(other, 'courses', 'submit', { id }).expect(403);
  });

  test('undoing an edit leaves nothing to apply; discarding the revision drops the pending details', async () => {
    const id = await publishedCourse(teacher, root, 'Undo Course');
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Undo Course', { summary: 'Changed' }) }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Undo Course') }).expect(200);   // back to the live details
    assert.equal((await call(teacher, 'courses', 'get', { id })).body.draft.details, null);
    await call(teacher, 'courses', 'updateMeta', { id, ...details('Undo Course', { summary: 'Changed again' }) }).expect(200);
    await call(teacher, 'courses', 'discardRevision', { id }).expect(200);
    const g = (await call(teacher, 'courses', 'get', { id })).body;
    assert.equal(g.draft, null);
    assert.equal(g.course.summary, 'Learn algebra');
  });

  test('before its first approval a course is edited directly, as before', async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Brand New' }).expect(200);
    const r = await call(teacher, 'courses', 'updateMeta', { id, ...details('Brand New', { summary: 'Fresh' }) }).expect(200);
    assert.equal(r.body.course.summary, 'Fresh');
    assert.equal(r.body.awaitingApproval, undefined);
    assert.equal((await auditFor(id, 'course.update')).length, 1);
  });
});
