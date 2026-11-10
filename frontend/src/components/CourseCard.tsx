import { Link } from 'react-router-dom';
import type { CourseMeta } from '../api';
import { levelLabel } from '../ui';
import { formatMoney } from '../money';

/** The two-leaf shape used as decoration in the course page header. */
export function Leaf({ className, color = 'currentColor' }: { className?: string; color?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 52 52" fill={color}>
      <path d="M51.4 0.3C51.4 0.3 30.3-3.5 27.1 16C27 19.7 27.1 51.7 27.1 51.7C27.1 51.7 49.6 55.7 51.4 34.9" />
      <path d="M24.5 38.8C24.5 38.8 2.7 42 0 23.6C0.1 22.5 0.1 0.4 0.1 0.4C0.1 0.4 20 -3.5 24.5 14.4" />
    </svg>
  );
}

export function CourseCard({ c }: { c: CourseMeta & { teacherName: string; lessonCount?: number; quizCount?: number; learners?: number } }) {
  const lessons = c.lessonCount != null ? `${c.lessonCount} ${c.lessonCount === 1 ? 'lesson' : 'lessons'}` : null;
  return (
    <Link to={`/courses/${c.id}`} className="course-card">
      <div className="course-card-body">
        <span className="course-cat">{c.category}</span>
        <h3>{c.title}</h3>
        <p className="course-meta">{[levelLabel(c.level), lessons].filter(Boolean).join(' · ')}</p>
        <p className="course-teacher">by {c.teacherName}</p>
        {c.price > 0 && <p className="course-price">{formatMoney(c.price, c.currency)}</p>}
      </div>
    </Link>
  );
}
