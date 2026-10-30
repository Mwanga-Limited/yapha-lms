import { Link } from 'react-router-dom';
import { api, apiUrl } from '../../api';
import { useAuth } from '../../auth';
import { Thumb } from '../../components/CourseCard';
import { Empty, ErrorState, Loading, ProgressBar, fmtDate, useDocumentTitle, useLoad } from '../../ui';

interface DashCourse {
  id: string; title: string; summary: string; category: string; teacherName: string; thumbnailUrl: string | null; courseStatus: string;
  enrolledAt: string; completedAt: string | null; lastAccessedAt: string | null;
  resume: { id: string; title: string; kind: string } | null;
  progress: { percent: number; done: number; total: number };
  certificate: { code: string; revoked: boolean } | null;
}

export function Dashboard() {
  useDocumentTitle('My learning');
  const { user } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<{ courses: DashCourse[] }>('account', 'dashboard'), []);
  const courses = data?.courses ?? [];
  const inProgress = courses.filter((c) => !c.completedAt);
  const done = courses.filter((c) => c.completedAt);
  const next = inProgress[0];

  return (
    <>
      <div className="page-head">
        {/* New learners (no courses yet) get "Welcome"; returning learners get "Welcome back" */}
        <h1>{courses.length > 0 ? 'Welcome back' : 'Welcome'}, {user?.name.split(' ')[0]}</h1>
      </div>
      {loading && <Loading />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {next && (
        <section className="resume-card">
          <Thumb url={next.thumbnailUrl} title={next.title} />
          <div className="resume-body">
            <span className="muted small">Continue where you left off</span>
            <h2>{next.title}</h2>
            {next.resume && <p className="muted">Last opened: {next.resume.title}</p>}
            <ProgressBar percent={next.progress.percent} label={`${next.title} progress`} />
            <Link className="btn btn-primary" to={`/learn/${next.id}${next.resume ? `?item=${next.resume.id}` : ''}`}>Resume course</Link>
          </div>
        </section>
      )}

      {data && courses.length === 0 && (
        <Empty title="You haven't enrolled in a course yet">
          <p>Pick one from the catalog. Your progress and certificates will show up here.</p>
          <Link className="btn btn-primary" to="/">Browse courses</Link>
        </Empty>
      )}

      {inProgress.length > 1 && (
        <section className="block">
          <h2>In progress</h2>
          <ul className="my-list">
            {inProgress.slice(1).map((c) => (
              <li key={c.id} className="my-row">
                <Thumb url={c.thumbnailUrl} title={c.title} />
                <div className="my-main">
                  <Link to={`/learn/${c.id}`}><strong>{c.title}</strong></Link>
                  <span className="muted small">{c.teacherName} · {c.progress.done} of {c.progress.total} done</span>
                  <ProgressBar percent={c.progress.percent} label={`${c.title} progress`} />
                </div>
                <Link className="btn btn-secondary btn-sm" to={`/learn/${c.id}${c.resume ? `?item=${c.resume.id}` : ''}`}>Continue</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section className="block">
          <h2>Completed</h2>
          <ul className="my-list">
            {done.map((c) => (
              <li key={c.id} className="my-row">
                <Thumb url={c.thumbnailUrl} title={c.title} />
                <div className="my-main">
                  <Link to={`/learn/${c.id}`}><strong>{c.title}</strong></Link>
                  <span className="muted small">Completed {fmtDate(c.completedAt)}</span>
                  {c.certificate && (c.certificate.revoked
                    ? <span className="badge badge-rejected">Certificate revoked</span>
                    : <span className="small">Certificate <code>{c.certificate.code}</code></span>)}
                </div>
                {c.certificate && !c.certificate.revoked && (
                  <div className="row-gap">
                    <a className="btn btn-primary btn-sm" href={apiUrl(`/certificates/${c.certificate.code}?format=pdf&download`)}>Download PDF</a>
                    <Link className="btn btn-secondary btn-sm" to={`/verify/${c.certificate.code}`}>Share link</Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
