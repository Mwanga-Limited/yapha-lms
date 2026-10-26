import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type CourseMeta, type LessonPayload, type OutlineSection } from '../api';
import { useAuth } from '../auth';
import { Thumb } from '../components/CourseCard';
import { LessonView } from '../components/LessonView';
import { Alert, Button, ErrorState, Loading, Modal, StatusBadge, levelLabel, plural, useAction, useDocumentTitle, useLoad } from '../ui';

interface Detail {
  course: CourseMeta & { learners: number };
  outline: OutlineSection[];
  teacher: { id: string; name: string; bio: string | null; expertise: string | null; photoUrl: string | null; courses: number };
  viewer: { enrolled: boolean; completed: boolean; canManage: boolean; signedIn: boolean; emailVerified: boolean };
}

export function CourseDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, error, loading } = useLoad(() => api<Detail>('courses', 'detail', { id }), [id, user?.id]);
  const [preview, setPreview] = useState<LessonPayload | null>(null);
  const { busy, run } = useAction();
  useDocumentTitle(data?.course.title ?? 'Course');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;
  const { course, outline, teacher, viewer } = data;
  const lessons = outline.flatMap((s) => s.items).filter((i) => i.kind === 'lesson').length;
  const quizzes = outline.flatMap((s) => s.items).filter((i) => i.kind === 'quiz').length;

  const enrol = async () => {
    if (!user) { nav('/login', { state: { from: `/courses/${id}` } }); return; }
    const r = await run(() => api('learn', 'enrol', { courseId: id }), 'You are enrolled');
    if (r) nav(`/learn/${id}`);
  };
  const openPreview = (lessonId: string) => run(async () => {
    const r = await api<{ lesson: LessonPayload }>('courses', 'preview', { courseId: id, lessonId });
    setPreview(r.lesson);
  });

  return (
    <div className="detail">
      <section className="detail-head">
        <div className="detail-intro">
          <Link to={`/?category=${encodeURIComponent(course.category)}`} className="course-cat">{course.category}</Link>
          <h1>{course.title}</h1>
          <p className="lede">{course.summary}</p>
          <ul className="facts">
            <li>{levelLabel(course.level)}</li>
            <li>{course.language}</li>
            <li>{plural(lessons, 'lesson')}, {plural(quizzes, 'quiz')}</li>
            <li>{plural(course.learners, 'learner')}</li>
          </ul>
          {course.status !== 'published' && <p><StatusBadge status={course.status} /> <span className="muted">This course is not in the catalog.</span></p>}
          <div className="detail-cta">
             {viewer.enrolled && user?.role === 'student' ? (
              <Link className="btn btn-primary btn-lg" to={`/learn/${id}`}>{viewer.completed ? 'Review the course' : 'Continue learning'}</Link>
             
                ) : course.status === 'published' && !viewer.canManage && (!user || user.role === 'student') ? (
              <Button className="btn-lg" busy={busy} onClick={enrol} disabled={!!user && !user.emailVerified}>Enrol for free</Button>
            ) : null}
            {viewer.canManage && <Link className="btn btn-secondary" to={user?.id === course.teacherId ? `/teach/courses/${id}` : `/admin/courses/${id}`}>Manage course</Link>}
          </div>
          {user && !user.emailVerified && !viewer.enrolled && <Alert tone="warn">Verify your email to enrol. We sent you a link when you signed up.</Alert>}
        </div>
        <div className="detail-thumb"><Thumb url={course.thumbnailUrl} title={course.title} /></div>
      </section>

      <div className="detail-cols">
        <div>
          {course.outline && (
            <section className="block">
              <h2>What you'll learn</h2>
              <ul className="learn-list">{course.outline.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}</ul>
            </section>
          )}
          <section className="block">
            <h2>Course content</h2>
            <ol className="outline">
              {outline.map((s) => (
                <li key={s.id}>
                  <h3>{s.title}</h3>
                  <ul>
                    {s.items.map((it) => (
                      <li key={it.id} className="outline-item">
                        <span className={`kind kind-${it.kind === 'quiz' ? 'quiz' : it.type}`}>{it.kind === 'quiz' ? 'Quiz' : it.type === 'video' ? 'Video' : it.type === 'file' ? 'File' : 'Reading'}</span>
                        <span className="outline-title">{it.title}</span>
                        {it.kind === 'lesson' && it.durationMin ? <span className="muted small">{it.durationMin} min</span> : null}
                        {it.kind === 'quiz' && <span className="muted small">{plural(it.questionCount ?? 0, 'question')}</span>}
                        {it.preview && !viewer.enrolled && <button className="link-btn" onClick={() => openPreview(it.id)}>Preview</button>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>
          {course.description && (
            <section className="block">
              <h2>About this course</h2>
              <div className="prose">{course.description.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
            </section>
          )}
        </div>
        <aside className="teacher-card">
          <h2>Your teacher</h2>
          <div className="teacher-top">
            {teacher.photoUrl ? <img src={teacher.photoUrl} alt="" className="avatar avatar-lg" /> : <span className="avatar avatar-lg avatar-initial">{teacher.name.charAt(0)}</span>}
            <div><strong>{teacher.name}</strong>{teacher.expertise && <div className="muted">{teacher.expertise}</div>}</div>
          </div>
          {teacher.bio && <p>{teacher.bio}</p>}
          <p className="muted small">{plural(teacher.courses, 'published course')}</p>
        </aside>
      </div>

      <Modal title={preview?.title ?? 'Preview'} open={!!preview} onClose={() => setPreview(null)} wide>
        {preview && <LessonView lesson={preview} />}
        <div className="row-end"><Button onClick={() => { setPreview(null); void enrol(); }}>Enrol to see every lesson</Button></div>
      </Modal>
    </div>
  );
}
