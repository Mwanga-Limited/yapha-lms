import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  OTHER_TENANT, TENANT, agent, buy, call, callIn, loginRoot, makeTeacher, outbox, pool, publishedCourse, registerStudent, resetDb,
} from './helpers.js';

let root, teacher;
before(async () => {
  await resetDb();
  root = await loginRoot();
  teacher = (await makeTeacher('Slug Teacher', root)).a;
});
after(async () => { await pool.end(); });

const slugOf = async (id) => (await call(root, 'courses', 'get', { id })).body.course.slug;

describe('Course web addresses (slugs)', () => {
  test('are made from the title; a second course with the same title gets "-2"', async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Bookkeeping: The Basics (2026)!' }).expect(200);
    assert.equal(await slugOf(id), 'bookkeeping-the-basics-2026');
    const { body: { id: id2 } } = await call(teacher, 'courses', 'create', { title: 'Bookkeeping – the basics 2026' }).expect(200);
    assert.equal(await slugOf(id2), 'bookkeeping-the-basics-2026-2');
  });

  test('the course page opens by slug (and old links by ID still work)', async () => {
    const id = await publishedCourse(teacher, root, 'Customer Service Essentials');
    const bySlug = (await call(agent(), 'courses', 'detail', { id: 'customer-service-essentials' }).expect(200)).body;
    assert.equal(bySlug.course.id, id);
    assert.equal(bySlug.course.slug, 'customer-service-essentials');
    assert.equal((await call(agent(), 'courses', 'detail', { id }).expect(200)).body.course.slug, 'customer-service-essentials');
    await call(agent(), 'courses', 'detail', { id: 'no-such-course' }).expect(404);
    const cat = (await call(agent(), 'courses', 'catalog', { q: 'Customer Service' })).body.courses[0];
    assert.equal(cat.slug, 'customer-service-essentials', 'catalogue cards link with the slug');
  });

  test('the slug follows the title until the course is published, then never changes (shared links keep working)', async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Draft Title' }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, title: 'Better Title' }).expect(200);
    assert.equal(await slugOf(id), 'better-title');

    const live = await publishedCourse(teacher, root, 'Launch Day Course');
    await call(teacher, 'courses', 'updateMeta', { id: live, title: 'Renamed After Launch', summary: 's', category: 'c', outline: 'o', suggestedPrice: 5000 }).expect(200);
    assert.equal(await slugOf(live), 'launch-day-course');
    await call(agent(), 'courses', 'detail', { id: 'launch-day-course' }).expect(200);
  });

  test('a paying learner opens the course player by slug; emails link with the slug', async () => {
    const id = await publishedCourse(teacher, root, 'Player By Slug');
    const s = await registerStudent('Slug Learner');
    await buy(s, id);
    const p = (await call(s.a, 'learn', 'player', { courseId: 'player-by-slug' }).expect(200)).body;
    assert.equal(p.course.id, id);
    const receipt = outbox.filter((m) => m.to === s.email && /Payment received/.test(m.subject)).at(-1);
    assert.match(receipt.text, new RegExp(`/${TENANT}/learn/player-by-slug`));
    const other = await registerStudent('Not Paid');
    await call(other.a, 'learn', 'player', { courseId: 'player-by-slug' }).expect(403);
  });

  test('slugs are unique inside an organisation; another organisation can use the same one', async () => {
    const rootB = await loginRoot(OTHER_TENANT);
    const teacherB = (await makeTeacher('Beta Slug Teacher', rootB, OTHER_TENANT)).a;
    const { body: { id } } = await callIn(OTHER_TENANT, teacherB, 'courses', 'create', { title: 'Customer Service Essentials' }).expect(200);
    assert.equal((await callIn(OTHER_TENANT, rootB, 'courses', 'get', { id })).body.course.slug, 'customer-service-essentials');
    // Through beta, the slug finds beta's own (unpublished) course, never alpha's published one.
    await callIn(OTHER_TENANT, agent(), 'courses', 'detail', { id: 'customer-service-essentials' }).expect(404);
    assert.equal((await callIn(OTHER_TENANT, rootB, 'courses', 'detail', { id: 'customer-service-essentials' }).expect(200)).body.course.id, id);
    await assert.rejects(pool.query(`UPDATE courses SET slug = 'better-title' WHERE slug = 'customer-service-essentials' AND tenant_id = (SELECT id FROM tenants WHERE slug = $1)`, [TENANT]), /duplicate key/);
  });
});
