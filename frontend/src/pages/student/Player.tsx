import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, type LessonPayload, type OutlineItem, type OutlineSection, type Progress, type SectionLock, apiUrl } from '../../api';
import { LessonView } from '../../components/LessonView';
import { Alert, Button, Empty, Loading, ProgressBar, useAction, useDocumentTitle, useLoad, useToast } from '../../ui';
import { watchLabel, type WatchState } from '../../watch';
import { QuizView, type QuizSubmitted } from './QuizView';

interface PlayerData {
  course: { id: string; slug: string; title: string; teacherName: string; status: string };
  outline: OutlineSection[];
  progress: Progress;
  resumeItemId: string | null;
  /** afterHours: the course opens this long after enrolling (null = at once). Sections open in order. */
  unlock?: { afterHours: number | null; enrolledAt: string };
  completedAt: string | null;
  certificate: { code: string; issuedAt: string; revoked: boolean; revokeReason: string | null } | null;
}

/** Why a section is locked, in a few words: "Opens 28 Nov, 10:00" or "Complete “Basics” first". */
function lockText(lock: SectionLock): string {
  return lock.reason === 'time' && lock.opensAt
    ? `Opens ${new Date(lock.opensAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : `Complete “${lock.after ?? 'the previous section'}” first`;
}

function LockedPanel({ lock }: { lock: SectionLock | null }) {
  return (
    <div className="panel locked-panel" data-testid="locked-panel">
      <span className="lock-icon" aria-hidden>🔒</span>
      {lock?.reason === 'time' && lock.opensAt ? (
        <>
          <h2>This course opens soon</h2>
          <p>It opens on <strong>{new Date(lock.opensAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</strong>. Come back then to start learning.</p>
        </>
      ) : (
        <>
          <h2>This section is locked</h2>
          <p>Complete every lesson and pass every quiz in <strong>“{lock?.after ?? 'the previous section'}”</strong> to unlock it.</p>
        </>
      )}
    </div>
  );
}

export function Player() {
  const { courseRef = '' } = useParams();   // the course's slug (or ID, for older links)
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useLoad(() => api<PlayerData>('learn', 'player', { courseId: courseRef }), [courseRef]);
  const courseId = data?.course.id ?? '';
  const anyLocked = useRef(false);   // is any section still locked? (then finishing an item may unlock one)
  useEffect(() => { anyLocked.current = !!data?.outline.some((s) => s.locked); }, [data]);
  // An old link with the course ID: show the readable address instead.
  useEffect(() => {
    if (data && data.course.slug && courseRef !== data.course.slug) nav(`/learn/${data.course.slug}${window.location.search}`, { replace: true });
  }, [data, courseRef]); // eslint-disable-line react-hooks/exhaustive-deps
  const [lesson, setLesson] = useState<{ lesson: LessonPayload; completed: boolean; positionSec: number; watch: WatchState | null } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const { busy, run } = useAction();
  useDocumentTitle(data?.course.title ?? 'Course');

  const items = useMemo(() => data?.outline.flatMap((s) => s.items) ?? [], [data]);
  const currentId = params.get('item') || data?.resumeItemId || items.find((i) => !i.locked)?.id || items[0]?.id || null;
  const current = items.find((i) => i.id === currentId) ?? items[0];
  const idx = current ? items.indexOf(current) : -1;

  useEffect(() => {
    setLesson(null);
    if (!current || current.kind !== 'lesson' || current.locked) return;
    api<{ lesson: LessonPayload; completed: boolean; positionSec: number; watch: WatchState | null }>('learn', 'lesson', { courseId, lessonId: current.id })
      .then(setLesson).catch((e) => toast(e.message, 'error'));
    setDrawer(false);
  }, [courseId, current?.id, current?.locked]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (it?: OutlineItem) => { if (it) { setParams({ item: it.id }); window.scrollTo({ top: 0 }); } };

  // Videos: report the position; the server counts what was really watched and completes the lesson itself.
  // lessonId is passed in, so a report sent while leaving a lesson is saved against that lesson, not the next one.
  const savePosition = useCallback((lessonId: string, sec: number, durationSec?: number, leaving = false) => {
    void api<{ watch?: WatchState; completed?: boolean; progress?: Progress; certificate?: { code: string } | null }>('learn', 'savePosition', {
      courseId, lessonId, positionSec: Math.round(sec * 10) / 10,
      ...(durationSec ? { durationSec: Math.round(durationSec * 10) / 10 } : {}),
    }, { keepalive: leaving }).then((r) => {
      if (r.watch) setLesson((l) => (l && l.lesson.id === lessonId ? { ...l, watch: r.watch!, completed: l.completed || !!r.completed } : l));
      if (r.progress) {
        applyProgress(r.progress, lessonId, { done: true }, r.certificate);
        if (!r.certificate) toast('Video watched. Lesson complete.');
      }
    }).catch(() => {});
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyProgress = (progress: Progress, doneId: string, patch?: Partial<OutlineItem>, certificate?: { code: string } | null) => {
    setData((d) => d && ({
      ...d, progress,
      outline: d.outline.map((s) => ({ ...s, items: s.items.map((it) => (it.id === doneId ? { ...it, ...patch } : it)) })),
    }));
    if (certificate) toast('Course complete — your certificate is ready');
    if (certificate || anyLocked.current) void reload();   // finishing an item can unlock the next section
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
          <Link className="btn btn-primary" to={`/courses/${courseRef}`}>Go to the course page</Link>
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
              <h3>{s.locked && <span aria-hidden>🔒 </span>}{s.title}{s.locked && <span className="side-section-lock">{lockText(s.locked)}</span>}</h3>
              <ul>
                {s.items.map((it) => (
                  <li key={it.id}>
                    <button className={`side-item ${it.id === current?.id ? 'current' : ''} ${it.done ? 'done' : ''} ${it.locked ? 'locked' : ''}`} onClick={() => go(it)} aria-current={it.id === current?.id || undefined}>
                      <span className="side-check" aria-hidden>{it.done ? '✓' : it.locked ? '🔒' : it.kind === 'quiz' && it.state?.lockedUntil ? '⏳' : ''}</span>
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
          {(() => {
            const wait = data.outline.find((s) => s.locked?.reason === 'time')?.locked;
            return wait?.opensAt ? (
              <Alert tone="info" title="This course opens soon">
                It opens on <strong>{new Date(wait.opensAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</strong>. Until then you can open the free preview lessons.
              </Alert>
            ) : null;
          })()}

          {!current && <Empty title="This course has no lessons yet" />}
          {current && (
            <>
              <div className="item-head">
                <span className="muted small">{idx + 1} of {items.length}{current.required ? ' · required to complete' : ''}</span>
                <h1>{current.title}</h1>
              </div>
              {current.locked && <LockedPanel lock={data.outline.find((s) => s.items.some((i) => i.id === current.id))?.locked ?? null} />}
              {!current.locked && current.kind === 'lesson' && (lesson && lesson.lesson.id === current.id ? (
                <>
                  <LessonView lesson={lesson.lesson} startAt={lesson.positionSec} onPosition={(sec, d, leaving) => savePosition(lesson.lesson.id, sec, d, leaving)} />
                  <div className="lesson-actions">
                    {current.done ? (
                      <>
                        <span className="ok-text">✓ Completed</span>
                        {items[idx + 1] && lesson.lesson.type === 'video' && <Button onClick={() => go(items[idx + 1])}>Next: {items[idx + 1].title}</Button>}
                      </>
                    ) : lesson.lesson.type === 'video' ? (
                      // No "Mark as complete" for videos: watching completes them.
                      <div className="watch-progress" data-testid="watch-progress" style={{ flex: 1, minWidth: 240, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <ProgressBar percent={lesson.watch?.percent ?? 0} label="Video watched" />
                        <p className="muted small" style={{ margin: 0 }}>{watchLabel(lesson.watch)}</p>
                      </div>
                    ) : <Button busy={busy} onClick={complete}>Mark as complete</Button>}
                  </div>
                </>
              ) : <Loading />)}
              {!current.locked && current.kind === 'quiz' && (
                <QuizView courseId={courseId} quizId={current.id} onSubmitted={(r: QuizSubmitted) =>
                  applyProgress(r.progress, current.id, { done: r.state.passed, state: r.state }, r.certificate)} />
              )}
              <nav className="prevnext" aria-label="Lesson navigation">
                <Button variant="secondary" disabled={idx <= 0} onClick={() => go(items[idx - 1])}>Previous</Button>
                <Button variant="secondary" disabled={idx >= items.length - 1} onClick={() => go(items[idx + 1])}>Next</Button>
              </nav>
            </>
          )}
          <p className="muted small player-foot">Taught by {data.course.teacherName} · <button className="link-btn" onClick={() => nav(`/courses/${data.course.slug}`)}>Course page</button></p>
        </section>
      </div>
    </div>
  );
}
