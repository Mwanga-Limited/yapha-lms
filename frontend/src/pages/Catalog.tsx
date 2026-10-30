import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type CourseMeta } from '../api';
import { CourseCard } from '../components/CourseCard';
import { Empty, ErrorState, Loading, Pager, useDocumentTitle, useLoad } from '../ui';

type Row = CourseMeta & { teacherName: string; lessonCount: number; quizCount: number; learners: number };
const LEVELS = [['', 'Any level'], ['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']] as const;

export function Catalog() {
  useDocumentTitle('Courses');
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
      <section className="hero">
        <h1>Learn something you can use on Monday.</h1>
        <p className="lede">Short, practical courses from approved teachers. Finish the lessons, pass the quizzes, and get a certificate anyone can check.</p>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() }); }}>
          <input type="search" aria-label="Search courses" placeholder="Search by topic, course or teacher" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" type="submit">Search</button>
        </form>
      </section>

      <div className="filters">
        <label className="filter">
          <span>Category</span>
          <select value={category} onChange={(e) => update({ category: e.target.value })}>
            <option value="">All categories</option>
            {data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div className="chips" role="group" aria-label="Level">
          {LEVELS.map(([v, l]) => <button key={v} className={level === v ? 'chip on' : 'chip'} aria-pressed={level === v} onClick={() => update({ level: v })}>{l}</button>)}
        </div>
        {data && <span className="muted count">{data.total} {data.total === 1 ? 'course' : 'courses'}</span>}
      </div>

      {loading && <Loading label="Finding courses" />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && !loading && (data.courses.length ? (
        <div className="grid">{data.courses.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <Empty title={q || category || level ? 'No courses match these filters' : 'No courses are published yet'}>
          {(q || category || level) && <button className="btn btn-secondary" onClick={() => { setText(''); setParams({}); }}>Clear filters</button>}
        </Empty>
      ))}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: String(p) })} />}
    </>
  );
}
