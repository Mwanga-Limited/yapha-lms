import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, upload, type Content, type CourseMeta, type VersionStatus } from '../../api';
import { Thumb } from '../../components/CourseCard';
import { ContentPreview } from '../../components/ContentPreview';
import { Learners } from '../../components/Learners';
import { Alert, Button, ErrorState, Field, Loading, Select, StatusBadge, Tabs, TextArea, fmtDateTime, useAction, useDocumentTitle, useLoad } from '../../ui';
import { ContentBuilder } from './ContentBuilder';

export interface CourseGet {
  course: CourseMeta;
  teacher: { id: string; name: string; email: string };
  enrollments: number;
  fileUrls: Record<string, string>;
  live: { id: string; versionNo: number; content: Content; reviewedAt: string } | null;
  draft: { id: string; versionNo: number; status: VersionStatus; content: Content; submittedAt: string | null; updatedAt: string } | null;
  problems: string[];
  reviews: { id: string; versionNo: number; decision: 'approved' | 'rejected'; reason: string | null; adminName: string; createdAt: string }[];
}

type Tab = 'details' | 'content' | 'review' | 'learners';

function DetailsForm({ g, onSaved }: { g: CourseGet; onSaved: () => void }) {
  const c = g.course;
  const [f, setF] = useState({ title: c.title, summary: c.summary, description: c.description, outline: c.outline, category: c.category, level: c.level, language: c.language });
  const [thumb, setThumb] = useState<{ id: string | null; url: string | null }>({ id: c.thumbnailFileId, url: c.thumbnailUrl });
  const { busy, run } = useAction();
  const up = useAction();
  const locked = c.status === 'in_review' || c.status === 'archived';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api('courses', 'updateMeta', { id: c.id, ...f, thumbnailFileId: thumb.id }); onSaved(); }, g.live ? 'Saved. The changes are live.' : 'Details saved');
  };
  return (
    <form onSubmit={save} className="panel">
      {g.live && <Alert tone="info">This course has an approved version. Edits to these details (typos, descriptions, thumbnail) go live straight away. Lessons, quizzes and the completion rule go through review.</Alert>}
      {c.status === 'in_review' && <Alert tone="info">The course is being reviewed. You can edit it again after the decision.</Alert>}
      <fieldset disabled={locked} className="plain">
        <Field label="Title" value={f.title} onChange={set('title')} required maxLength={200} />
        <Field label="Summary" hint="One or two sentences shown on the course card." value={f.summary} onChange={set('summary')} maxLength={500} />
        <div className="grid-3">
          <Field label="Category" value={f.category} onChange={set('category')} placeholder="e.g. Business" list="cat-suggestions" />
          <datalist id="cat-suggestions">{['Business', 'Technology', 'Design', 'Languages', 'Mathematics', 'Science', 'Health', 'Personal development'].map((x) => <option key={x} value={x} />)}</datalist>
          <Select label="Level" value={f.level} onChange={set('level')}>
            <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
          </Select>
          <Field label="Language" value={f.language} onChange={set('language')} />
        </div>
        <TextArea label="Outline: what learners will learn" rows={5} value={f.outline} onChange={set('outline')} hint="One point per line. Required before you submit." />
        <TextArea label="Description" rows={6} value={f.description} onChange={set('description')} />
        <div className="field">
          <span className="label-like">Thumbnail</span>
          <div className="thumb-edit">
            <Thumb url={thumb.url} title={f.title || 'Course'} />
            <div className="row-gap">
              <label className="btn btn-secondary btn-sm">{up.busy ? 'Uploading…' : 'Upload image'}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void up.run(async () => { const r = await upload(file, 'thumbnail'); setThumb({ id: r.id, url: r.url }); }); }} />
              </label>
              {thumb.id && <button type="button" className="link-btn" onClick={() => setThumb({ id: null, url: null })}>Remove</button>}
            </div>
          </div>
        </div>
        <Button type="submit" busy={busy}>Save details</Button>
      </fieldset>
    </form>
  );
}

function ContentTab({ g, reload }: { g: CourseGet; reload: () => Promise<void> }) {
  const editable = !!g.draft && ['draft', 'rejected'].includes(g.draft.status) && g.course.status !== 'archived';
  const [content, setContent] = useState<Content | null>(g.draft?.content ?? null);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { setContent(g.draft?.content ?? null); setDirty(false); }, [g.draft?.id, g.draft?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!g.draft && g.live) {
    return (
      <div className="stack">
        <Alert tone="info" title="You're looking at the live version">
          To change lessons, quizzes or the completion rule, start a revision. Learners keep seeing this version until an admin approves the new one.
        </Alert>
        {g.course.status !== 'archived' && <div><Button busy={busy} onClick={() => run(async () => { await api('courses', 'startRevision', { id: g.course.id }); await reload(); }, 'Revision started')}>Start a revision</Button></div>}
        <ContentPreview content={g.live.content} fileUrls={g.fileUrls} />
      </div>
    );
  }
  if (!g.draft || !content) return null;
  if (!editable) {
    return (
      <div className="stack">
        <Alert tone="info" title="Waiting for review">This version was submitted {fmtDateTime(g.draft.submittedAt)}. It can't be changed while an admin reviews it.</Alert>
        <ContentPreview content={g.draft.content} compareTo={g.live?.content} fileUrls={g.fileUrls} />
      </div>
    );
  }

  const save = () => run(async () => {
    await api('courses', 'saveContent', { id: g.course.id, content });
    setDirty(false);
    await reload();
  }, 'Content saved');

  return (
    <div className="stack">
      {g.live && (
        <div className="row-between">
          <Alert tone="info">You're editing revision {g.draft.versionNo}. The live version stays visible to learners until this one is approved.</Alert>
          <Button variant="ghost" small onClick={() => { if (confirm('Discard this revision? Your changes will be lost.')) void run(async () => { await api('courses', 'discardRevision', { id: g.course.id }); await reload(); }, 'Revision discarded'); }}>Discard revision</Button>
        </div>
      )}
      <ContentBuilder value={content} onChange={(c) => { setContent(c); setDirty(true); }} />
      <div className={`savebar ${dirty ? 'dirty' : ''}`}>
        <span>{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
        <Button busy={busy} disabled={!dirty} onClick={save}>Save content</Button>
      </div>
    </div>
  );
}

function ReviewTab({ g, reload }: { g: CourseGet; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const [problems, setProblems] = useState<string[]>([]);
  const canSubmit = !!g.draft && ['draft', 'rejected'].includes(g.draft.status) && g.course.status !== 'archived';
  const shown = problems.length ? problems : g.problems;
  const lastReject = g.reviews.find((r) => r.decision === 'rejected');

  const submit = () => run(async () => {
    try {
      await api('courses', 'submit', { id: g.course.id });
      setProblems([]);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.problems.length) setProblems(e.problems);
      throw e;
    }
  }, 'Submitted for review');

  return (
    <div className="stack">
      {g.draft?.status === 'rejected' && lastReject && (
        <Alert tone="warn" title="An admin asked for changes">{lastReject.reason}</Alert>
      )}
      {g.draft?.status === 'in_review' && <Alert tone="info" title="In review">Submitted {fmtDateTime(g.draft.submittedAt)}. You'll get an email and a notification when an admin decides.</Alert>}
      {canSubmit && (
        <div className="panel">
          <h2>{g.draft!.status === 'rejected' ? 'Resubmit for review' : g.live ? 'Submit this revision' : 'Submit for review'}</h2>
          {shown.length ? (
            <>
              <p>Fix these before you submit:</p>
              <ul className="checklist">{shown.map((p) => <li key={p}>{p}</li>)}</ul>
            </>
          ) : <p className="ok-text">Everything needed is in place: outline, lessons, a quiz and a completion rule.</p>}
          <p className="muted small">Save your content first. Submitting needs a verified email.</p>
          <Button busy={busy} disabled={shown.length > 0} onClick={submit}>Submit for review</Button>
        </div>
      )}
      <div className="panel">
        <h2>Review history</h2>
        {g.reviews.length === 0 ? <p className="muted">No decisions yet.</p> : (
          <ol className="history">
            {g.reviews.map((r) => (
              <li key={r.id}>
                <StatusBadge status={r.decision} /> <strong>Version {r.versionNo}</strong> by {r.adminName}, {fmtDateTime(r.createdAt)}
                {r.reason && <p>{r.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function CourseActions({ g, reload, after }: { g: CourseGet; reload: () => Promise<void>; after?: (action: string) => void }) {
  const { busy, run } = useAction();
  const c = g.course;
  const act = (action: string, msg: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    void run(async () => { await api('courses', action, { id: c.id }); if (after) after(action); else await reload(); }, msg);
  };
  return (
    <div className="row-gap">
      {(c.status === 'approved' || c.status === 'unpublished') && <Button busy={busy} onClick={() => act('publish', 'Published')}>Publish</Button>}
      {c.status === 'published' && <Button variant="secondary" busy={busy} onClick={() => act('unpublish', 'Unpublished', 'Hide this course from the catalog? Enrolled learners keep access.')}>Unpublish</Button>}
      {c.status === 'published' && <Link className="btn btn-ghost" to={`/courses/${c.id}`}>View in catalog</Link>}
      {c.status !== 'archived' && c.status !== 'in_review' && (g.enrollments > 0 || g.reviews.length > 0 || c.status !== 'draft') && (
        <Button variant="ghost" busy={busy} onClick={() => act('archive', 'Archived', 'Archive this course? It leaves the catalog for good; enrolled learners keep access.')}>Archive</Button>
      )}
      {c.status === 'draft' && g.enrollments === 0 && g.reviews.length === 0 && (
        <Button variant="danger" busy={busy} onClick={() => act('remove', 'Draft deleted', 'Delete this draft permanently?')}>Delete draft</Button>
      )}
    </div>
  );
}

export function CourseEditor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api<CourseGet>('courses', 'get', { id }), [id]);
  const [tab, setTab] = useState<Tab>('content');
  useDocumentTitle(data?.course.title ?? 'Course');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;
  const g = data;
  const revision = g.live && g.draft ? { draft: 'Revision draft', in_review: 'Revision in review', rejected: 'Revision needs changes', approved: '', superseded: '' }[g.draft.status] : null;

  return (
    <>
      <div className="page-head editor-head">
        <div>
          <Link to="/teach" className="small">Your courses</Link>
          <h1>{g.course.title}</h1>
          <div className="row-gap"><StatusBadge status={g.course.status} />{revision && <span className="badge badge-in_review">{revision}</span>}<span className="muted small">{g.enrollments} enrolled</span></div>
        </div>
        <CourseActions g={g} reload={reload} after={(a) => (a === 'remove' ? nav('/teach') : void reload())} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'content', label: 'Lessons & quizzes' },
        { id: 'details', label: 'Details' },
        { id: 'review', label: <>Review{g.problems.length > 0 && g.draft && ['draft', 'rejected'].includes(g.draft.status) ? ` (${g.problems.length} to fix)` : ''}</> },
        { id: 'learners', label: 'Learners' },
      ]} />
      <div className="tab-panel">
        {tab === 'details' && <DetailsForm g={g} onSaved={reload} />}
        {tab === 'content' && <ContentTab g={g} reload={reload} />}
        {tab === 'review' && <ReviewTab g={g} reload={reload} />}
        {tab === 'learners' && <Learners courseId={g.course.id} />}
      </div>
    </>
  );
}
