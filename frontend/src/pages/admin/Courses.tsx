import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CourseMeta } from '../../api';
import { Empty, Loading, Pager, StatusBadge, fmtDate, useDocumentTitle, useLoad } from '../../ui';
import { AdminNav } from './Dashboard';

type Row = CourseMeta & { teacherName: string; learners: number; revisionStatus: string | null };
const STATUSES = ['', 'draft', 'in_review', 'rejected', 'approved', 'published', 'unpublished', 'archived'];

export function AdminCourses() {
  useDocumentTitle('All courses');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, loading } = useLoad(() => api<{ courses: Row[]; total: number; pageSize: number }>('admin', 'courses', { q: query, status, page }), [query, status, page]);
  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>All courses</h1></div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }}>
        <input type="search" aria-label="Search courses" placeholder="Title or teacher" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace('_', ' ') : 'Any status'}</option>)}
        </select>
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.courses.length === 0 && <Empty title="No courses found" />}
      {data && data.courses.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Course</th><th>Teacher</th><th>Status</th><th>Enrolments</th><th>Updated</th></tr></thead>
            <tbody>
              {data.courses.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/admin/courses/${c.id}`}><strong>{c.title}</strong></Link></td>
                  <td>{c.teacherName}</td>
                  <td><StatusBadge status={c.status} />{c.revisionStatus && c.status !== 'draft' && c.status !== 'in_review' && c.status !== 'rejected' && <div className="small muted">revision {c.revisionStatus.replace('_', ' ')}</div>}</td>
                  <td>{c.learners}</td>
                  <td>{fmtDate(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
