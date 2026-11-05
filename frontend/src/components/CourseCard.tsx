import { Link } from 'react-router-dom';
import type { CourseMeta } from '../api';
import { levelLabel } from '../ui';

/** The two-leaf shape used as decoration on covers and in the course page header. */
export function Leaf({ className, color = 'currentColor' }: { className?: string; color?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 52 52" fill={color}>
      <path d="M51.4 0.3C51.4 0.3 30.3-3.5 27.1 16C27 19.7 27.1 51.7 27.1 51.7C27.1 51.7 49.6 55.7 51.4 34.9" />
      <path d="M24.5 38.8C24.5 38.8 2.7 42 0 23.6C0.1 22.5 0.1 0.4 0.1 0.4C0.1 0.4 20 -3.5 24.5 14.4" />
    </svg>
  );
}

// Generated covers use the organisation's colours, picked per course so neighbouring cards differ.
const COVERS = ['cover-accent', 'cover-ink', 'cover-tint', 'cover-ink2'];

export function Thumb({ url, title, index }: { url: string | null; title: string; index?: number }) {
  if (url) return <img className="thumb" src={url} alt="" loading="lazy" />;
  // In a list, covers take turns; elsewhere the course title picks one, so it stays the same everywhere.
  const n = index ?? [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7);
  return <div className={`thumb thumb-gen ${COVERS[n % COVERS.length]}`} aria-hidden><Leaf className="thumb-leaf" /></div>;
}

export function CourseCard({ c, index }: { c: CourseMeta & { teacherName: string; lessonCount?: number; quizCount?: number; learners?: number }; index?: number }) {
  const lessons = c.lessonCount != null ? `${c.lessonCount} ${c.lessonCount === 1 ? 'lesson' : 'lessons'}` : null;
  return (
    <Link to={`/courses/${c.id}`} className="course-card">
      <Thumb url={c.thumbnailUrl} title={c.title} index={index} />
      <div className="course-card-body">
        <span className="course-cat">{c.category}</span>
        <h3>{c.title}</h3>
        <p className="course-meta">{[levelLabel(c.level), lessons].filter(Boolean).join(' · ')}</p>
        <p className="course-teacher">by {c.teacherName}</p>
      </div>
    </Link>
  );
}
