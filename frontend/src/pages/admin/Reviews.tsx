import { Link } from 'react-router-dom';
import { api, type CourseMeta } from '../../api';
import { Empty, Loading, fmtDateTime, plural, useDocumentTitle, useLoad } from '../../ui';
import { AdminNav } from './Dashboard';

interface QueueItem { versionId: string; versionNo: number; submittedAt: string; isRevision: boolean; course: CourseMeta; teacherName: string; teacherEmail: string; rejections: number; lessonCount: number; quizCount: number }

export function AdminReviews() {
  useDocumentTitle('Course reviews');
  const { data, loading } = useLoad(() => api<{ queue: QueueItem[] }>('admin', 'reviewQueue'), []);
  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Course reviews</h1><p className="muted">Oldest first. Open a course to preview everything, including quiz answers.</p></div>
      {loading && !data && <Loading />}
      {data && data.queue.length === 0 && <Empty title="Nothing to review">New submissions and revisions of live courses appear here.</Empty>}
      <ul className="queue">
        {data?.queue.map((q) => (
          <li key={q.versionId}>
            <Link to={`/admin/courses/${q.course.id}`} className="queue-item">
              <div>
                <strong>{q.course.title}</strong>
                <span className="muted small">{q.teacherName} · version {q.versionNo} · submitted {fmtDateTime(q.submittedAt)}</span>
              </div>
              <div className="queue-tags">
                {q.isRevision ? <span className="badge badge-in_review">Revision of a live course</span> : <span className="badge badge-draft">New course</span>}
                {q.rejections > 0 && <span className="badge badge-rejected">{plural(q.rejections, 'earlier rejection')}</span>}
                <span className="muted small">{plural(q.lessonCount, 'lesson')}, {plural(q.quizCount, 'quiz')}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
