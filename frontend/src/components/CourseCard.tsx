import { Link } from 'react-router-dom';
import type { CourseMeta } from '../api';
import { levelLabel } from '../ui';

export function Thumb({ url, title }: { url: string | null; title: string }) {
  if (url) return <img className="thumb" src={url} alt="" loading="lazy" />;
  // A generated cover: the course initials on a ruled page.
  const initials = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const hue = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <div className="thumb thumb-gen" style={{ ['--h' as string]: hue }} aria-hidden><span>{initials}</span></div>;
}

export function CourseCard({ c }: { c: CourseMeta & { teacherName: string; lessonCount?: number; quizCount?: number; learners?: number } }) {
  return (
    <Link to={`/courses/${c.id}`} className="course-card">
      <Thumb url={c.thumbnailUrl} title={c.title} />
      <div className="course-card-body">
        <span className="course-cat">{c.category}</span>
        <h3>{c.title}</h3>
        <p className="muted clamp2">{c.summary}</p>
        <div className="course-foot">
          <span>{c.teacherName}</span>
          <span className="lvl">{levelLabel(c.level)}</span>
        </div>
      </div>
    </Link>
  );
}
