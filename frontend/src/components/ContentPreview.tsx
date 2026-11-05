import type { Content, Item } from '../api';
import { plural } from '../ui';

const kindLabel = (it: Item) => (it.kind === 'quiz' ? 'Quiz' : it.type === 'video' ? 'Video' : it.type === 'file' ? 'File' : 'Reading');

/** Full read-only view of course content (with correct answers) for reviewers and teachers. */
export function ContentPreview({ content, compareTo, fileUrls = {} }: { content: Content; compareTo?: Content | null; fileUrls?: Record<string, string> }) {
  const oldItems = new Map((compareTo?.sections ?? []).flatMap((s) => s.items).map((i) => [i.id, i]));
  const newIds = new Set(content.sections.flatMap((s) => s.items).map((i) => i.id));
  const removed = compareTo ? [...oldItems.values()].filter((i) => !newIds.has(i.id)) : [];
  const required = (it: Item) => (it.kind === 'lesson' ? content.completion.lessons : content.completion.quizzes).includes(it.id);
  const wasRequired = (it: Item) => (it.kind === 'lesson' ? compareTo?.completion.lessons : compareTo?.completion.quizzes)?.includes(it.id);
  const change = (it: Item) => {
    if (!compareTo) return null;
    const old = oldItems.get(it.id);
    if (!old) return 'New';
    if (JSON.stringify(old) !== JSON.stringify(it)) return 'Changed';
    if (required(it) !== !!wasRequired(it)) return 'Rule changed';
    return null;
  };

  if (!content.sections.length) return <p className="muted">No sections yet.</p>;
  return (
    <div className="preview">
      {content.sections.map((s, si) => (
        <section key={s.id} className="preview-section">
          <h3>Section {si + 1}: {s.title || <em>Untitled</em>}</h3>
          {s.items.map((it) => {
            const ch = change(it);
            return (
              <details key={it.id} className="preview-item">
                <summary>
                  <span className={`kind kind-${it.kind === 'quiz' ? 'quiz' : it.type}`}>{kindLabel(it)}</span>
                  <span className="outline-title">{it.title || <em>Untitled</em>}</span>
                  {required(it) && <span className="badge badge-approved">Required</span>}
                  {it.kind === 'lesson' && it.preview && <span className="badge badge-draft">Free preview</span>}
                  {ch && <span className="badge badge-in_review">{ch}</span>}
                </summary>
                {it.kind === 'lesson' ? (
                  <div className="preview-body">
                    {it.type === 'video' && (it.fileId
                      ? <video src={fileUrls[it.fileId]} controls preload="metadata" className="preview-video" />
                      : <p>Video link: <a href={it.videoUrl} target="_blank" rel="noreferrer">{it.videoUrl || '—'}</a></p>)}
                    {it.type === 'file' && (it.fileId ? <p>File: <a href={fileUrls[it.fileId]} target="_blank" rel="noreferrer">{it.fileName || 'Open file'}</a></p> : <p className="muted">No file uploaded</p>)}
                    {it.body && <div className="prose">{it.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>}
                  </div>
                ) : (
                  <div className="preview-body">
                    {it.description && <p>{it.description}</p>}
                    <ol className="answer-key">
                      {it.questions.map((q) => (
                        <li key={q.id}>
                          <strong>{q.prompt || <em>No question text</em>}</strong> <span className="muted small">({q.type === 'multi' ? 'multi-select' : q.type === 'truefalse' ? 'true/false' : 'single choice'})</span>
                          <ul>{q.options.map((o) => <li key={o.id} className={q.correct.includes(o.id) ? 'key-correct' : ''}>{q.correct.includes(o.id) ? '✓ ' : ''}{o.text}</li>)}</ul>
                        </li>
                      ))}
                    </ol>
                    {!it.questions.length && <p className="muted">No questions</p>}
                  </div>
                )}
              </details>
            );
          })}
        </section>
      ))}
      {removed.length > 0 && (
        <div className="removed">
          <strong>Removed in this revision:</strong> {removed.map((r) => `${kindLabel(r)} “${r.title}”`).join(', ')}
        </div>
      )}
      <p className="muted small">
        Completion rule: {plural(content.completion.lessons.length, 'required lesson')} and {plural(content.completion.quizzes.length, 'required quiz')}
        {compareTo && JSON.stringify(compareTo.completion) !== JSON.stringify(content.completion) ? ' (changed in this revision)' : ''}.
      </p>
    </div>
  );
}
