import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, type LessonPayload, type OutlineItem, type OutlineSection, type Progress, apiUrl } from '../../api';
import { LessonView } from '../../components/LessonView';
import { Alert, Button, Empty, Loading, ProgressBar, useAction, useDocumentTitle, useLoad, useToast } from '../../ui';
import { QuizView, type QuizSubmitted } from './QuizView';

interface PlayerData {
  course: { id: string; title: string; teacherName: string; status: string };
  outline: OutlineSection[];
  progress: Progress;
  resumeItemId: string | null;
  completedAt: string | null;
  certificate: { code: string; issuedAt: string; revoked: boolean; revokeReason: string | null } | null;
}

export function Player() {
  const { courseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useLoad(() => api<PlayerData>('learn', 'player', { courseId }), [courseId]);
  const [lesson, setLesson] = useState<{ lesson: LessonPayload; completed: boolean; positionSec: number } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const { busy, run } = useAction();
  useDocumentTitle(data?.course.title ?? 'Course');

  const items = useMemo(() => data?.outline.flatMap((s) => s.items) ?? [], [data]);
  const currentId = params.get('item') || data?.resumeItemId || items[0]?.id || null;
  const current = items.find((i) => i.id === currentId) ?? items[0];
  const idx = current ? items.indexOf(current) : -1;

  useEffect(() => {
    setLesson(null);
    if (!current || current.kind !== 'lesson') return;
    api<{ lesson: LessonPayload; completed: boolean; positionSec: number }>('learn', 'lesson', { courseId, lessonId: current.id })
      .then(setLesson).catch((e) => toast(e.message, 'error'));
    setDrawer(false);
  }, [courseId, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (it?: OutlineItem) => { if (it) { setParams({ item: it.id }); window.scrollTo({ top: 0 }); } };

  const savePosition = useCallback((sec: number) => {
    if (current) void api('learn', 'savePosition', { courseId, lessonId: current.id, positionSec: Math.round(sec * 10) / 10 }).catch(() => {});
  }, [courseId, current]);

  const applyProgress = (progress: Progress, doneId: string, patch?: Partial<OutlineItem>, certificate?: { code: string } | null) => {
    setData((d) => d && ({
      ...d, progress,
      outline: d.outline.map((s) => ({ ...s, items: s.items.map((it) => (it.id === doneId ? { ...it, ...patch } : it)) })),
    }));
    if (certificate) { toast('Course complete — your certificate is ready'); void reload(); }
  };

  const complete = async () => {
    if (!current) return;
    const r = await run(() => api<{ progress: Progress; certificate: { code: string } | null }>('learn', 'completeLesson', { courseId, lessonId: current.id }));
    if (!r) return;
    applyProgress(r.progress, current.id, { done: true }, r.certificate);
    setLesson((l) => l && { ...l, completed: true });
    if (!r.certificate && items[idx + 1]) go(items[idx + 1]);
  };

  if (loading && !data) return <div className="player-loading"><Loading /></div>;
  if (error) {
    const notEnrolled = error instanceof ApiError && error.code === 'NOT_ENROLLED';
    return (
      <div className="wrap main">
        <Empty title={notEnrolled ? 'Enrol to open this course' : 'This course could not be opened'}>
          <p>{error instanceof Error ? error.message : ''}</p>
          <Link className="btn btn-primary" to={`/courses/${courseId}`}>Go to the course page</Link>
        </Empty>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="player">
      <header className="player-bar">
        <Link to="/dashboard" className="icon-btn" aria-label="Back to my learning">←</Link>
        <div className="player-title">
          <strong>{data.course.title}</strong>
          <ProgressBar percent={data.progress.percent} label="Course progress" />
        </div>
        <button className="btn btn-secondary btn-sm player-toggle" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>Contents</button>
      </header>

      <div className="player-body">
        <aside className={`player-side ${drawer ? 'open' : ''}`} aria-label="Course contents">
          {data.outline.map((s) => (
            <section key={s.id}>
              <h3>{s.title}</h3>
              <ul>
                {s.items.map((it) => (
                  <li key={it.id}>
                    <button className={`side-item ${it.id === current?.id ? 'current' : ''} ${it.done ? 'done' : ''}`} onClick={() => go(it)} aria-current={it.id === current?.id || undefined}>
                      <span className="side-check" aria-hidden>{it.done ? '✓' : it.kind === 'quiz' && it.state?.lockedUntil ? '⏳' : ''}</span>
                      <span className="side-text">
                        <span>{it.title}</span>
                        <small>{it.kind === 'quiz' ? 'Quiz' : it.type === 'video' ? 'Video' : it.type === 'file' ? 'File' : 'Reading'}{it.required ? ' · required' : ''}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </aside>

        <section className="player-main">
          {data.completedAt && data.certificate && (
            <div className={`cert-banner ${data.certificate.revoked ? 'revoked' : ''}`}>
              {data.certificate.revoked ? (
                <span>Your certificate for this course was revoked: {data.certificate.revokeReason}</span>
              ) : (
                <>
                  <span><strong>You completed this course.</strong> Certificate <code>{data.certificate.code}</code></span>
                  <span className="row-gap">
                    <a className="btn btn-primary btn-sm" href={apiUrl(`/certificates/${data.certificate.code}?format=pdf&download`)}>Download PDF</a>
                    <Link className="btn btn-secondary btn-sm" to={`/verify/${data.certificate.code}`}>Verification page</Link>
                  </span>
                </>
              )}
            </div>
          )}
          {data.course.status !== 'published' && <Alert tone="info">This course is no longer in the catalog, but you keep access to it.</Alert>}

          {!current && <Empty title="This course has no lessons yet" />}
          {current && (
            <>
              <div className="item-head">
                <span className="muted small">{idx + 1} of {items.length}{current.required ? ' · required to complete' : ''}</span>
                <h1>{current.title}</h1>
              </div>
              {current.kind === 'lesson' && (lesson && lesson.lesson.id === current.id ? (
                <>
                  <LessonView lesson={lesson.lesson} startAt={lesson.positionSec} onPosition={savePosition}
                    onEnded={() => { if (!current.done) void complete(); }} />
                  <div className="lesson-actions">
                    {current.done ? <span className="ok-text">✓ Completed</span> : <Button busy={busy} onClick={complete}>Mark as complete</Button>}
                  </div>
                </>
              ) : <Loading />)}
              {current.kind === 'quiz' && (
                <QuizView courseId={courseId} quizId={current.id} onSubmitted={(r: QuizSubmitted) =>
                  applyProgress(r.progress, current.id, { done: r.state.passed, state: r.state }, r.certificate)} />
              )}
              <nav className="prevnext" aria-label="Lesson navigation">
                <Button variant="secondary" disabled={idx <= 0} onClick={() => go(items[idx - 1])}>Previous</Button>
                <Button variant="secondary" disabled={idx >= items.length - 1} onClick={() => go(items[idx + 1])}>Next</Button>
              </nav>
            </>
          )}
          <p className="muted small player-foot">Taught by {data.course.teacherName} · <button className="link-btn" onClick={() => nav(`/courses/${courseId}`)}>Course page</button></p>
        </section>
      </div>
    </div>
  );
}
