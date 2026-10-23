import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type CourseMeta, type VersionStatus } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Button, Empty, Field, Loading, StatusBadge, TextArea, fmtDate, useAction, useDocumentTitle, useLoad } from '../../ui';

interface Application { id: string; bio: string; expertise: string; credential_url: string | null; status: 'pending' | 'approved' | 'declined'; decision_reason: string | null; reviewed_at: string | null; created_at: string }
type MyCourse = CourseMeta & { learners: number; revision: { status: VersionStatus; versionNo: number } | null; hasLive: boolean; lastDecision: string | null; lastReason: string | null };

function Apply() {
  const { data, loading, reload } = useLoad(() => api<{ applications: Application[] }>('account', 'myApplications'), []);
  const [f, setF] = useState({ bio: '', expertise: '', credentialUrl: '' });
  const { busy, run } = useAction();
  if (loading && !data) return <Loading />;
  const latest = data?.applications[0];
  const submit = (e: FormEvent) => { e.preventDefault(); void run(async () => { await api('account', 'applyTeacher', f); await reload(); }, 'Application sent'); };

  return (
    <>
      <div className="page-head"><h1>Teach on Learn</h1><p className="lede">Share what you know. Every teacher is approved by an admin, and every course is reviewed before it goes live.</p></div>
      {latest?.status === 'pending' && (
        <Alert tone="info" title="Your application is being reviewed">
          Sent {fmtDate(latest.created_at)} for <strong>{latest.expertise}</strong>. We'll notify you and email you when an admin decides.
        </Alert>
      )}
      {latest?.status === 'declined' && (
        <Alert tone="warn" title="Your last application was declined">Reason: {latest.decision_reason}. You can update your details and apply again.</Alert>
      )}
      {latest?.status !== 'pending' && (
        <form className="panel narrow" onSubmit={submit}>
          <h2>Instructor application</h2>
          <Field label="Area of expertise" value={f.expertise} onChange={(e) => setF({ ...f, expertise: e.target.value })} required placeholder="e.g. Bookkeeping for small businesses" />
          <TextArea label="Short profile" rows={5} minLength={20} required value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })}
            hint="Your experience and what you'd like to teach. At least 20 characters." />
          <Field label="ID or credential link (optional)" type="url" placeholder="https://" value={f.credentialUrl} onChange={(e) => setF({ ...f, credentialUrl: e.target.value })}
            hint="A LinkedIn profile, certificate or portfolio helps the review." />
          <Button type="submit" busy={busy}>Send application</Button>
        </form>
      )}
    </>
  );
}

function revisionText(c: MyCourse) {
  if (!c.revision || !c.hasLive) return null;
  return { draft: 'Revision in progress', in_review: 'Revision in review', rejected: 'Revision needs changes', approved: '', superseded: '' }[c.revision.status];
}

function MyCourses() {
  const nav = useNavigate();
  const { data, loading } = useLoad(() => api<{ courses: MyCourse[] }>('courses', 'mine'), []);
  const [title, setTitle] = useState('');
  const { busy, run } = useAction();
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { const r = await api<{ id: string }>('courses', 'create', { title }); nav(`/teach/courses/${r.id}`); });
  };
  return (
    <>
      <div className="page-head"><h1>Your courses</h1></div>
      <form className="new-course" onSubmit={create}>
        <Field label="Start a new course" placeholder="Course title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        <Button type="submit" busy={busy}>Create draft</Button>
      </form>
      {loading && !data && <Loading />}
      {data && data.courses.length === 0 && <Empty title="No courses yet">Give your first course a title above. You can save drafts and submit when it's ready.</Empty>}
      {data && data.courses.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Course</th><th>Status</th><th>Learners</th><th>Updated</th></tr></thead>
            <tbody>
              {data.courses.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/teach/courses/${c.id}`)}>
                  <td>
                    <Link to={`/teach/courses/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.title}</strong></Link>
                    {c.lastDecision === 'rejected' && (c.status === 'rejected' || c.revision?.status === 'rejected') && <div className="small warn-text">Admin: {c.lastReason}</div>}
                  </td>
                  <td><StatusBadge status={c.status} />{revisionText(c) && <div className="small muted">{revisionText(c)}</div>}</td>
                  <td>{c.learners}</td>
                  <td>{fmtDate(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function TeachHome() {
  useDocumentTitle('Teach');
  const { user } = useAuth();
  return user?.role === 'student' ? <Apply /> : <MyCourses />;
}
