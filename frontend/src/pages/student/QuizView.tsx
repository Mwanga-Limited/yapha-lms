import { useEffect, useState } from 'react';
import { api, type Progress, type QuizState } from '../../api';
import { Alert, Button, Loading, fmtDateTime, useAction, useLoad } from '../../ui';

interface LearnerQuestion { id: string; type: 'single' | 'multi' | 'truefalse'; prompt: string; options: { id: string; text: string }[] }
interface QuizData { quiz: { id: string; title: string; description: string; questions: LearnerQuestion[] }; state: QuizState; attempts: { score: number; passed: boolean; created_at: string }[] }
interface Result { score: number; passed: boolean; correct: number; total: number; questions: { questionId: string; correct: boolean }[] }
export interface QuizSubmitted { state: QuizState; progress: Progress; certificate: { code: string } | null; result: Result }

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const ms = new Date(until).getTime() - now;
  const h = Math.max(0, Math.floor(ms / 3600e3)), m = Math.max(0, Math.floor((ms % 3600e3) / 60e3));
  return <>{h} h {m} min</>;
}

export function QuizView({ courseId, quizId, onSubmitted }: { courseId: string; quizId: string; onSubmitted: (r: QuizSubmitted) => void }) {
  const { data, loading, error, reload } = useLoad(() => api<QuizData>('learn', 'quiz', { courseId, quizId }), [courseId, quizId]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<Result | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { setAnswers({}); setResult(null); }, [quizId]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert tone="error">This quiz could not be loaded. <button className="link-btn" onClick={reload}>Try again</button></Alert>;
  const { quiz, state, attempts } = data;
  const locked = !!state.lockedUntil;
  const canAttempt = !state.passed && !locked && state.attemptsLeft > 0;
  const answered = quiz.questions.filter((q) => (answers[q.id] ?? []).length > 0).length;
  const verdict = (qid: string) => result?.questions.find((x) => x.questionId === qid)?.correct;

  const pick = (q: LearnerQuestion, optionId: string, checked: boolean) => {
    if (result) setResult(null);
    setAnswers((a) => {
      const cur = a[q.id] ?? [];
      return { ...a, [q.id]: q.type === 'multi' ? (checked ? [...cur, optionId] : cur.filter((x) => x !== optionId)) : [optionId] };
    });
  };

  const submit = async () => {
    const r = await run(() => api<QuizSubmitted>('learn', 'submitQuiz', { courseId, quizId, answers }));
    if (!r) { void reload(); return; }
    setResult(r.result);
    onSubmitted(r);
    await reload();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <article className="quiz">
      {quiz.description && <p className="lede">{quiz.description}</p>}
      <div className="quiz-rules">
        <span>Pass mark <strong>{state.passMark}%</strong></span>
        <span>{state.passed ? 'Passed' : `${state.attemptsLeft} of ${state.maxAttempts} attempts left`}</span>
        {state.bestScore != null && <span>Best score <strong>{state.bestScore}%</strong></span>}
      </div>

      {result && (
        <Alert tone={result.passed ? 'ok' : 'warn'} title={result.passed ? `Passed with ${result.score}%` : `You scored ${result.score}%`}>
          {result.correct} of {result.total} correct.{' '}
          {!result.passed && (locked ? 'You have used all 3 attempts.' : `You need ${state.passMark}% to pass. Review the questions marked below and try again.`)}
        </Alert>
      )}
      {state.passed && !result && <Alert tone="ok" title="You passed this quiz">Best score {state.bestScore}%.</Alert>}
      {locked && (
        <Alert tone="warn" title="This quiz is locked for now">
          You used all 3 attempts. It unlocks in <Countdown until={state.lockedUntil!} /> ({fmtDateTime(state.lockedUntil)}), then you get 3 more attempts.
          Your teacher can also reset your attempts.
        </Alert>
      )}

      {canAttempt && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <ol className="questions">
            {quiz.questions.map((q) => {
              const v = verdict(q.id);
              return (
                <li key={q.id} className={`question ${v === true ? 'q-right' : v === false ? 'q-wrong' : ''}`}>
                  <fieldset>
                    <legend>{q.prompt}{q.type === 'multi' && <span className="muted small"> Choose all that apply.</span>}</legend>
                    {q.options.map((o) => (
                      <label key={o.id} className="option">
                        <input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={q.id} checked={(answers[q.id] ?? []).includes(o.id)}
                          onChange={(e) => pick(q, o.id, e.target.checked)} />
                        <span>{o.text}</span>
                      </label>
                    ))}
                    {v === false && <small className="field-error">Not quite.</small>}
                    {v === true && <small className="ok-text">Correct.</small>}
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <div className="quiz-submit">
            <span className="muted">{answered} of {quiz.questions.length} answered</span>
            <Button type="submit" busy={busy} disabled={answered < quiz.questions.length}>Submit answers</Button>
          </div>
        </form>
      )}

      {attempts.length > 0 && (
        <details className="attempts">
          <summary>Your attempts ({attempts.length})</summary>
          <ul>{attempts.map((a, i) => <li key={i}>{fmtDateTime(a.created_at)}: {a.score}% {a.passed ? '(passed)' : ''}</li>)}</ul>
        </details>
      )}
    </article>
  );
}
