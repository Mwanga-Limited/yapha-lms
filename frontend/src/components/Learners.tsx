import { api } from '../api';
import { Empty, Loading, fmtDate, fmtDateTime, useAction, useLoad } from '../ui';

interface LearnerRow {
  enrollmentId: string; name: string; email: string; status: string; enrolledAt: string; completedAt: string | null; progress: number;
  quizzes: { quizId: string; title: string; attemptsUsed: number; maxAttempts: number; passed: boolean; bestScore: number | null; lockedUntil: string | null }[];
}

/** Learners of a course with quiz attempt status; Teacher of the course or Admin can reset attempts (QZ-02). */
export function Learners({ courseId }: { courseId: string }) {
  const { data, loading, reload } = useLoad(() => api<{ learners: LearnerRow[] }>('courses', 'learners', { id: courseId }), [courseId]);
  const { busy, run } = useAction();
  if (loading && !data) return <Loading />;
  if (!data?.learners.length) return <Empty title="No learners yet">Learners appear here once the course is published and someone enrols.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Learner</th><th>Enrolled</th><th>Progress</th><th>Quizzes</th></tr></thead>
        <tbody>
          {data.learners.map((l) => (
            <tr key={l.enrollmentId}>
              <td><strong>{l.name}</strong><div className="muted small">{l.email}</div></td>
              <td>{fmtDate(l.enrolledAt)}{l.completedAt && <div className="ok-text small">Completed {fmtDate(l.completedAt)}</div>}</td>
              <td>{l.progress}%</td>
              <td>
                <ul className="quiz-cells">
                  {l.quizzes.map((q) => (
                    <li key={q.quizId}>
                      <span>{q.title}: </span>
                      {q.passed ? <span className="ok-text">passed ({q.bestScore}%)</span>
                        : q.lockedUntil ? <span className="warn-text">locked until {fmtDateTime(q.lockedUntil)}</span>
                        : <span className="muted">{q.attemptsUsed} of {q.maxAttempts} attempts used</span>}
                      {!q.passed && (q.attemptsUsed > 0 || q.lockedUntil) && (
                        <button className="link-btn" disabled={busy} onClick={() => run(async () => { await api('courses', 'resetAttempts', { enrollmentId: l.enrollmentId, quizId: q.quizId }); await reload(); }, `Attempts reset for ${l.name}`)}>Reset attempts</button>
                      )}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
