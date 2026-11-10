import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { ContentPreview } from '../../components/ContentPreview';
import { Learners } from '../../components/Learners';
import { Alert, Button, ErrorState, Field, Loading, ReasonModal, StatusBadge, Tabs, TextArea, fmtDateTime, levelLabel, useAction, useDocumentTitle, useLoad, useToast } from '../../ui';
import { CourseActions, type CourseGet } from '../teacher/CourseEditor';
import { AdminNav } from './Dashboard';
import { formatMoney, fromMinor } from '../../money';
import type { CourseMeta } from '../../api';

/** The Admin sets what learners pay, before or after publishing. Learners who already paid keep their access. */
function PriceEditor({ c, reload }: { c: CourseMeta; reload: () => Promise<void> }) {
  const [price, setPrice] = useState(c.price > 0 ? String(fromMinor(c.price)) : c.suggestedPrice > 0 ? String(fromMinor(c.suggestedPrice)) : '');
  const { busy, run } = useAction();
  const changed = Number(price) > 0 && Number(price) !== fromMinor(c.price);
  return (
    <section className="panel price-panel" data-testid="price-editor">
      <h2>Price</h2>
      <p className="muted small">
        {c.price > 0 ? <>Learners pay <strong>{formatMoney(c.price, c.currency)}</strong>.</> : <strong className="warn-text">No price yet: learners can't enrol and the course can't be published.</strong>}
        {' '}The teacher suggested {c.suggestedPrice > 0 ? formatMoney(c.suggestedPrice, c.currency) : 'no price'}.
        {' '}Every course is paid. One payment gives full access; changing the price doesn't affect learners who already have access.
      </p>
      <form className="row-gap" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('courses', 'setPrice', { id: c.id, price: Number(price) }); await reload(); }, 'Price saved'); }}>
        <Field label={`Price (${c.currency})`} type="number" min={1} max={10000000} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Button type="submit" busy={busy} disabled={!changed || price === ''}>Save price</Button>
      </form>
    </section>
  );
}

export function AdminCourse() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => api<CourseGet>('courses', 'get', { id }), [id]);
  const [tab, setTab] = useState<'content' | 'learners' | 'history'>('content');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [approvePrice, setApprovePrice] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  useDocumentTitle(data?.course.title ?? 'Course');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;
  const g = data;
  const c = g.course;
  const inReview = g.draft?.status === 'in_review';
  const newInReview = inReview && !g.live;
  const priceOnApproval = approvePrice ?? String(fromMinor(c.suggestedPrice));
  const shown = inReview || (!g.live && g.draft) ? g.draft!.content : g.live?.content;

  return (
    <>
      <AdminNav />
      <div className="page-head editor-head">
        <div>
          <Link to={inReview ? '/admin/reviews' : '/admin/courses'} className="small">{inReview ? 'Course reviews' : 'All courses'}</Link>
          <h1>{c.title}</h1>
          <div className="row-gap"><StatusBadge status={c.status} />{g.draft && g.live && <span className="badge badge-in_review">Revision {g.draft.versionNo}: {g.draft.status.replace('_', ' ')}</span>}
            <span className="muted small">by {g.teacher.name} ({g.teacher.email}) · {g.enrollments} enrolled</span></div>
        </div>
        <CourseActions g={g} reload={reload} />
      </div>

      {inReview && (
        <section className="decision">
          <div>
            <h2>{g.live ? `Revision ${g.draft!.versionNo} of a live course` : 'New course'} submitted {fmtDateTime(g.draft!.submittedAt)}</h2>
            <p className="muted">{g.live ? 'Items marked New or Changed differ from the live version. If you approve, this version replaces it for every learner.' : 'If you approve, the teacher can publish it to the catalog.'}</p>
            {g.problems.length > 0 && <Alert tone="warn" title="Automatic checks found issues">{g.problems.join('; ')}</Alert>}
          </div>
          <div className="decision-actions">
            {newInReview && (
              <Field label={`Price learners pay (${c.currency})`} type="number" min={1} required max={10000000} step="0.01" inputMode="decimal"
                value={priceOnApproval} onChange={(e) => setApprovePrice(e.target.value)}
                hint={`The teacher suggested ${c.suggestedPrice > 0 ? formatMoney(c.suggestedPrice, c.currency) : 'no price'}. Every course is paid. You can change it later.`} />
            )}
            <TextArea label="Note to the teacher (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row-gap">
              <Button busy={busy} disabled={newInReview && !(Number(priceOnApproval) > 0)} onClick={() => run(async () => {
                await api('admin', 'approveCourse', { versionId: g.draft!.id, note, ...(newInReview ? { price: Number(priceOnApproval) } : {}) });
                await reload();
              }, 'Course approved')}>Approve</Button>
              <Button variant="danger" onClick={() => setRejecting(true)}>Reject with a reason</Button>
            </div>
          </div>
        </section>
      )}

      {!newInReview && <PriceEditor key={`${c.id}-${c.price}`} c={c} reload={reload} />}

      <div className="meta-grid">
        <div><span className="muted small">Category</span><div>{c.category || '—'}</div></div>
        <div><span className="muted small">Level</span><div>{levelLabel(c.level)}</div></div>
        <div><span className="muted small">Language</span><div>{c.language}</div></div>
        <div className="span-3"><span className="muted small">Summary</span><div>{c.summary || '—'}</div></div>
        <div className="span-3"><span className="muted small">Outline</span><div className="pre">{c.outline || '—'}</div></div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'content', label: 'Content' }, { id: 'learners', label: 'Learners' }, { id: 'history', label: `Review history (${g.reviews.length})` }]} />
      <div className="tab-panel">
        {tab === 'content' && (shown ? <ContentPreview content={shown} compareTo={inReview ? g.live?.content : null} fileUrls={g.fileUrls} /> : <p className="muted">No content.</p>)}
        {tab === 'learners' && <Learners courseId={c.id} />}
        {tab === 'history' && (g.reviews.length ? (
          <ol className="history">{g.reviews.map((r) => <li key={r.id}><StatusBadge status={r.decision} /> <strong>Version {r.versionNo}</strong> by {r.adminName}, {fmtDateTime(r.createdAt)}{r.reason && <p>{r.reason}</p>}</li>)}</ol>
        ) : <p className="muted">No decisions yet.</p>)}
      </div>

      <ReasonModal open={rejecting} onClose={() => setRejecting(false)} title="Reject this course" label="What should the teacher change?" confirmLabel="Reject course"
        onConfirm={async (reason) => {
          try { await api('admin', 'rejectCourse', { versionId: g.draft!.id, reason }); toast('Course rejected. The teacher can see your reason.'); setRejecting(false); await reload(); }
          catch (e) { toast((e as Error).message, 'error'); }
        }} />
    </>
  );
}
