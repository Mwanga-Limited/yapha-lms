import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type CourseMeta } from '../api';
import { useAuth, useTenant } from '../auth';
import { CourseCard, Leaf } from '../components/CourseCard';
import { Empty, ErrorState, Loading, Pager, useDocumentTitle, useLoad } from '../ui';

type Row = CourseMeta & { teacherName: string; lessonCount: number; quizCount: number; learners: number };
const LEVELS = [['', 'Any level'], ['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']] as const;

export function Catalog() {
  useDocumentTitle('Courses');
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const level = params.get('level') || '';
  const page = Number(params.get('page') || 1);
  const [text, setText] = useState(q);

  const { data, error, loading, reload } = useLoad(
    () => api<{ courses: Row[]; total: number; pageSize: number; categories: string[] }>('courses', 'catalog', { q, category, level, page }),
    [q, category, level, page],
  );
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };

  return (
    <>
      <section className="hero-band">
        <div aria-hidden className="hero-dots" />
        <Leaf className="hero-leaf hero-leaf-a" />
        <Leaf className="hero-leaf hero-leaf-b" />
        <div className="hero-inner">
          <CatalogIntro />
          <form className="search-pill" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() }); }}>
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input type="search" aria-label="Search courses" placeholder="What do you want to learn?" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit">Search</button>
          </form>
          {!user && (
            <ul className="hero-ticks">
              <li>Free to join</li><li>Self-paced</li><li>Verifiable certificates</li>
            </ul>
          )}
        </div>
      </section>

      <div className="courses-head">
        <div>
          <h2>{q ? `Results for “${q}”` : 'All courses'}</h2>
          {data && <p className="muted small">{data.total} {data.total === 1 ? 'course' : 'courses'}</p>}
        </div>
        <div className="courses-filters">
          <div className="chips" role="group" aria-label="Category">
            <button className={!category ? 'chip on' : 'chip'} aria-pressed={!category} onClick={() => update({ category: '' })}>All</button>
            {data?.categories.map((c) => (
              <button key={c} className={category === c ? 'chip on' : 'chip'} aria-pressed={category === c} onClick={() => update({ category: c })}>{c}</button>
            ))}
          </div>
          <label className="level-select">
            <span className="sr-only">Level</span>
            <select value={level} onChange={(e) => update({ level: e.target.value })}>
              {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
      </div>

      {loading && <Loading label="Finding courses" />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && !loading && (data.courses.length ? (
        <div className="grid">{data.courses.map((c, i) => <CourseCard key={c.id} c={c} index={i} />)}</div>
      ) : (
        <Empty title={q || category || level ? 'No courses match these filters' : 'No courses are published yet'}>
          {(q || category || level) && <button className="btn btn-secondary" onClick={() => { setText(''); setParams({}); }}>Clear filters</button>}
        </Empty>
      ))}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: String(p) })} />}
    </>
  );
}

/** The top of the course page: different words for visitors, Students, Teachers and Admins. */
function CatalogIntro() {
  const { user } = useAuth();
  const tenant = useTenant();
  const firstName = user?.name.split(' ')[0] ?? '';
  const role = user?.role;
  const badge = (suffix?: string) => (
    <span className="hero-badge"><Leaf className="hero-badge-leaf" />{tenant.name}{suffix ? ` · ${suffix}` : ''}</span>
  );

  if (role === 'teacher') {
    return (
      <>
        {badge('Teacher')}
        <h1>Courses your learners can see</h1>
        <p className="hero-lede">This is the catalogue as students see it. To create a course, edit your content or check your learners’ progress, go to My courses.</p>
        <div className="hero-actions"><Link className="btn btn-primary" to="/teach">Go to My courses</Link></div>
      </>
    );
  }
  if (role === 'admin' || role === 'superadmin') {
    return (
      <>
        {badge('Admin')}
        <h1>Course catalogue</h1>
        <p className="hero-lede">Every course published at {tenant.name}, as learners see it. Approve new courses, manage people and change settings from the Admin area.</p>
        <div className="hero-actions">
          <Link className="btn btn-primary" to="/admin/reviews">Review courses</Link>
          <Link className="btn btn-secondary" to="/admin">Open Admin</Link>
        </div>
      </>
    );
  }
  if (role === 'student') {
    return (
      <>
        {badge()}
        <h1>Welcome, {firstName}. <span className="hl-text">What next?</span></h1>
        <p className="hero-lede">Choose a course and enrol. Learn at your own pace, pass the quizzes and earn a certificate when you finish.</p>
        <div className="hero-actions"><Link className="btn btn-secondary" to="/dashboard">Continue my learning</Link></div>
      </>
    );
  }
  return (
    <>
      {badge()}
      <h1>Learn at your pace. <span className="hl-text">Get certified</span> for it.</h1>
      <p className="hero-lede">Practical courses reviewed by {tenant.name}, short lessons and quizzes, and a certificate anyone can verify online.</p>
    </>
  );
}
