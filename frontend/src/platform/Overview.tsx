import { Link } from 'react-router-dom';
import { platformApi } from '../api';
import { Empty, ErrorState, Loading, StatusBadge, timeAgo, useDocumentTitle, useLoad } from '../ui';
import type { TenantRow } from './types';

interface Stats {
  stats: Record<'tenants' | 'active_tenants' | 'members' | 'students' | 'teachers' | 'published_courses' | 'enrollments' | 'completions' | 'certificates' | 'awaiting_review', number>;
  tenants: TenantRow[];
}

export function PlatformOverview() {
  useDocumentTitle('Overview');
  const { data, error, loading, reload } = useLoad(() => platformApi<Stats>('stats'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { stats: s, tenants } = data!;
  return (
    <>
      <div className="page-head row-between">
        <div><h1>All organisations</h1><p className="muted">What's happening across the platform. Each organisation only ever sees its own block.</p></div>
        <Link className="btn btn-primary" to="/organisations?new=1">Add an organisation</Link>
      </div>
      <dl className="stats">
        <div><dt>Organisations</dt><dd>{s.tenants}</dd><small>{s.active_tenants} active{s.tenants - s.active_tenants ? ` · ${s.tenants - s.active_tenants} suspended` : ''}</small></div>
        <div><dt>Members</dt><dd>{s.members}</dd><small>{s.students} students · {s.teachers} teachers</small></div>
        <div><dt>Active enrolments</dt><dd>{s.enrollments}</dd><small>{s.completions} completions</small></div>
        <div><dt>Published courses</dt><dd>{s.published_courses}</dd><small>{s.awaiting_review} waiting for review</small></div>
      </dl>
      {tenants.length === 0 ? <Empty title="No organisations yet"><Link className="btn btn-primary" to="/organisations?new=1">Add the first organisation</Link></Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Organisation</th><th>Status</th><th>Members</th><th>Courses</th><th>Enrolments</th><th>Certificates</th><th>In review</th><th>Last activity</th></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td><Link to={`/organisations/${t.id}`}><strong>{t.displayName}</strong></Link><div className="muted small">/t/{t.slug}</div></td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>{t.counts!.members}<div className="muted small">{t.counts!.students} S · {t.counts!.teachers} T · {t.counts!.admins} A</div></td>
                  <td>{t.counts!.publishedCourses}</td>
                  <td>{t.counts!.enrollments}<div className="muted small">{t.counts!.completions} completed</div></td>
                  <td>{t.counts!.certificates}</td>
                  <td>{t.counts!.awaitingReview || '—'}</td>
                  <td className="small">{t.lastActivity ? timeAgo(t.lastActivity) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
