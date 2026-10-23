import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorState, Loading, useDocumentTitle, useLoad } from '../../ui';

interface Stats {
  stats: Record<'users' | 'students' | 'teachers' | 'admins' | 'deactivated' | 'enrollments' | 'completions' | 'certificates' | 'published_courses' | 'awaiting_review' | 'pending_applications', number>;
  daily: { day: string; enrollments: number; completions: number }[];
}

export const adminLinks = [
  { to: '/admin/reviews', label: 'Course reviews' },
  { to: '/admin/applications', label: 'Teacher applications' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/courses', label: 'All courses' },
  { to: '/admin/certificates', label: 'Certificates' },
  { to: '/admin/audit', label: 'Audit log' },
];

export function AdminNav() {
  return (
    <nav className="subnav" aria-label="Admin">
      <Link to="/admin">Overview</Link>
      {adminLinks.map((l) => <Link key={l.to} to={l.to}>{l.label}</Link>)}
    </nav>
  );
}

export function AdminDashboard() {
  useDocumentTitle('Admin');
  const { data, error, loading, reload } = useLoad(() => api<Stats>('admin', 'stats'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const s = data!.stats;
  const max = Math.max(1, ...data!.daily.map((d) => d.enrollments));

  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Overview</h1></div>

      <div className="todo">
        <Link to="/admin/reviews" className={`todo-item ${s.awaiting_review ? 'has' : ''}`}>
          <strong>{s.awaiting_review}</strong><span>{s.awaiting_review === 1 ? 'course waits' : 'courses wait'} for review</span>
        </Link>
        <Link to="/admin/applications" className={`todo-item ${s.pending_applications ? 'has' : ''}`}>
          <strong>{s.pending_applications}</strong><span>teacher {s.pending_applications === 1 ? 'application' : 'applications'} to decide</span>
        </Link>
      </div>

      <dl className="stats">
        <div><dt>Users</dt><dd>{s.users}</dd><small>{s.students} students · {s.teachers} teachers · {s.admins} admins{s.deactivated ? ` · ${s.deactivated} deactivated` : ''}</small></div>
        <div><dt>Active enrolments</dt><dd>{s.enrollments}</dd></div>
        <div><dt>Completions</dt><dd>{s.completions}</dd><small>{s.certificates} valid certificates</small></div>
        <div><dt>Published courses</dt><dd>{s.published_courses}</dd></div>
      </dl>

      <section className="panel">
        <h2>Enrolments and completions, last 14 days</h2>
        <div className="bars" role="img" aria-label="Daily enrolments and completions">
          {data!.daily.map((d) => (
            <div key={d.day} className="bar-col" title={`${d.day}: ${d.enrollments} enrolments, ${d.completions} completions`}>
              <div className="bar-stack">
                <div className="bar bar-e" style={{ height: `${(d.enrollments / max) * 100}%` }} />
                <div className="bar bar-c" style={{ height: `${(d.completions / max) * 100}%` }} />
              </div>
              <span>{new Date(d.day).getDate()}</span>
            </div>
          ))}
        </div>
        <p className="legend"><span className="sw sw-e" /> Enrolments <span className="sw sw-c" /> Completions</p>
      </section>
    </>
  );
}
