import { useState } from 'react';
import { newId, upload, type Content, type Item, type LessonItem, type LessonType, type Question, type QuizItem } from '../../api';
import { Button, Field, Select, TextArea, useAction } from '../../ui';

type Mutate = (fn: (c: Content) => void) => void;

const blankLesson = (): LessonItem => ({ id: newId(), kind: 'lesson', title: '', type: 'text', body: '', videoUrl: '', fileId: null, fileName: '', preview: false, durationMin: null });
const blankQuiz = (): QuizItem => ({ id: newId(), kind: 'quiz', title: '', description: '', questions: [blankQuestion()] });
function blankQuestion(): Question {
  const a = newId(), b = newId();
  return { id: newId(), type: 'single', prompt: '', options: [{ id: a, text: '' }, { id: b, text: '' }], correct: [] };
}
const TF = [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];

function move<T>(arr: T[], i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function QuestionEditor({ q, n, update, remove }: { q: Question; n: number; update: (fn: (q: Question) => void) => void; remove?: () => void }) {
  const multi = q.type === 'multi';
  return (
    <div className="q-edit">
      <div className="q-edit-head">
        <strong>Question {n}</strong>
        <select aria-label="Question type" value={q.type} onChange={(e) => update((x) => {
          x.type = e.target.value as Question['type'];
          if (x.type === 'truefalse') { x.options = TF.map((o) => ({ ...o })); x.correct = []; }
          else if (x.options[0]?.id === 'true') { x.options = [{ id: newId(), text: '' }, { id: newId(), text: '' }]; x.correct = []; }
          if (x.type !== 'multi') x.correct = x.correct.slice(0, 1);
        })}>
          <option value="single">Multiple choice, one answer</option>
          <option value="multi">Multiple choice, several answers</option>
          <option value="truefalse">True or false</option>
        </select>
        {remove && <button type="button" className="link-btn danger-text" onClick={remove}>Remove question</button>}
      </div>
      <TextArea label="Question" rows={2} value={q.prompt} onChange={(e) => update((x) => { x.prompt = e.target.value; })} />
      <fieldset className="opts">
        <legend className="small muted">{multi ? 'Tick every correct answer' : 'Select the correct answer'}</legend>
        {q.options.map((o, oi) => (
          <div key={o.id} className="opt-row">
            <input type={multi ? 'checkbox' : 'radio'} name={`correct-${q.id}`} aria-label={`Option ${oi + 1} is correct`} checked={q.correct.includes(o.id)}
              onChange={(e) => update((x) => { x.correct = multi ? (e.target.checked ? [...x.correct, o.id] : x.correct.filter((c) => c !== o.id)) : [o.id]; })} />
            {q.type === 'truefalse' ? <span>{o.text}</span> : (
              <input className="opt-text" aria-label={`Option ${oi + 1}`} placeholder={`Option ${oi + 1}`} value={o.text}
                onChange={(e) => update((x) => { x.options[oi].text = e.target.value; })} />
            )}
            {q.type !== 'truefalse' && q.options.length > 2 && (
              <button type="button" className="icon-btn" aria-label="Remove option" onClick={() => update((x) => { x.options.splice(oi, 1); x.correct = x.correct.filter((c) => c !== o.id); })}>✕</button>
            )}
          </div>
        ))}
        {q.type !== 'truefalse' && q.options.length < 10 && (
          <button type="button" className="link-btn" onClick={() => update((x) => { x.options.push({ id: newId(), text: '' }); })}>Add option</button>
        )}
      </fieldset>
    </div>
  );
}

function LessonFields({ it, set }: { it: LessonItem; set: (fn: (l: LessonItem) => void) => void }) {
  const { busy, run } = useAction();
  const pick = (file?: File) => file && run(async () => {
    const f = await upload(file, it.type === 'video' ? 'lesson_video' : 'lesson_file');
    set((l) => { l.fileId = f.id; l.fileName = f.name; });
  }, 'File uploaded');
  return (
    <>
      <div className="grid-2">
        <Select label="Lesson type" value={it.type} onChange={(e) => set((l) => { l.type = e.target.value as LessonType; l.fileId = null; l.fileName = ''; })}>
          <option value="text">Reading (text)</option>
          <option value="video">Video</option>
          <option value="file">Downloadable file (PDF, slides)</option>
        </Select>
        <Field label="Length in minutes (optional)" type="number" min={0} value={it.durationMin ?? ''} onChange={(e) => set((l) => { l.durationMin = e.target.value === '' ? null : Number(e.target.value); })} />
      </div>
      {it.type === 'video' && (
        <div className="upload-row">
          <Field label="Video link" type="url" placeholder="YouTube, Vimeo or an .mp4 link" value={it.fileId ? '' : it.videoUrl} disabled={!!it.fileId}
            onChange={(e) => set((l) => { l.videoUrl = e.target.value; })} hint={it.fileId ? 'Using the uploaded video' : 'Learners resume uploaded and .mp4 videos where they stopped.'} />
          <span className="or-inline">or</span>
          <FilePick busy={busy} accept="video/mp4,video/webm,video/ogg,video/quicktime" name={it.fileName} onPick={pick} onClear={it.fileId ? () => set((l) => { l.fileId = null; l.fileName = ''; }) : undefined} label="Upload video (max 500 MB)" />
        </div>
      )}
      {it.type === 'file' && (
        <FilePick busy={busy} accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip,.txt,.png,.jpg" name={it.fileName} onPick={pick} label="Upload file (max 50 MB)" />
      )}
      <TextArea label={it.type === 'text' ? 'Lesson text' : 'Notes for learners (optional)'} rows={it.type === 'text' ? 10 : 3} value={it.body}
        onChange={(e) => set((l) => { l.body = e.target.value; })} hint={it.type === 'text' ? 'Leave a blank line between paragraphs.' : undefined} />
      <label className="check"><input type="checkbox" checked={it.preview} onChange={(e) => set((l) => { l.preview = e.target.checked; })} /> Free preview: anyone can open this lesson from the course page</label>
    </>
  );
}

function FilePick({ busy, accept, name, onPick, onClear, label }: { busy: boolean; accept: string; name: string; onPick: (f?: File) => void; onClear?: () => void; label: string }) {
  return (
    <div className="field">
      <span className="label-like">{label}</span>
      <div className="row-gap">
        <label className="btn btn-secondary btn-sm">{busy ? 'Uploading…' : name ? 'Replace file' : 'Choose file'}
          <input type="file" accept={accept} hidden onChange={(e) => onPick(e.target.files?.[0])} />
        </label>
        {name && <span className="small">{name}</span>}
        {onClear && <button type="button" className="link-btn" onClick={onClear}>Remove</button>}
      </div>
    </div>
  );
}

function ItemEditor({ it, si, ii, count, mutate, open, toggle, required }: {
  it: Item; si: number; ii: number; count: number; mutate: Mutate; open: boolean; toggle: () => void; required: boolean;
}) {
  const setItem = (fn: (x: Item) => void) => mutate((c) => fn(c.sections[si].items[ii]));
  const setRequired = (on: boolean) => mutate((c) => {
    const key = it.kind === 'lesson' ? 'lessons' : 'quizzes';
    c.completion[key] = on ? [...new Set([...c.completion[key], it.id])] : c.completion[key].filter((x) => x !== it.id);
  });
  return (
    <div className={`item-edit ${open ? 'open' : ''}`}>
      <div className="item-edit-head">
        <button type="button" className="item-toggle" onClick={toggle} aria-expanded={open}>
          <span className={`kind kind-${it.kind === 'quiz' ? 'quiz' : it.type}`}>{it.kind === 'quiz' ? 'Quiz' : it.type === 'video' ? 'Video' : it.type === 'file' ? 'File' : 'Reading'}</span>
          <span className="outline-title">{it.title || <em className="muted">Untitled {it.kind}</em>}</span>
        </button>
        <label className="check small"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required</label>
        <div className="item-tools">
          <button type="button" className="icon-btn" aria-label="Move up" disabled={ii === 0} onClick={() => mutate((c) => move(c.sections[si].items, ii, -1))}>↑</button>
          <button type="button" className="icon-btn" aria-label="Move down" disabled={ii === count - 1} onClick={() => mutate((c) => move(c.sections[si].items, ii, 1))}>↓</button>
          <button type="button" className="icon-btn" aria-label="Delete" onClick={() => { if (confirm(`Delete “${it.title || 'this item'}”?`)) mutate((c) => { c.sections[si].items.splice(ii, 1); c.completion.lessons = c.completion.lessons.filter((x) => x !== it.id); c.completion.quizzes = c.completion.quizzes.filter((x) => x !== it.id); }); }}>✕</button>
        </div>
      </div>
      {open && (
        <div className="item-edit-body">
          <Field label={it.kind === 'quiz' ? 'Quiz title' : 'Lesson title'} value={it.title} onChange={(e) => setItem((x) => { x.title = e.target.value; })} />
          {it.kind === 'lesson'
            ? <LessonFields it={it} set={(fn) => setItem((x) => fn(x as LessonItem))} />
            : (
              <>
                <TextArea label="Instructions (optional)" rows={2} value={it.description} onChange={(e) => setItem((x) => { (x as QuizItem).description = e.target.value; })} />
                <p className="muted small">Auto-graded. Learners need 70% to pass and get 3 attempts, then the quiz locks for 24 hours.</p>
                {it.questions.map((q, qi) => (
                  <QuestionEditor key={q.id} q={q} n={qi + 1}
                    update={(fn) => setItem((x) => fn((x as QuizItem).questions[qi]))}
                    remove={it.questions.length > 1 ? () => setItem((x) => { (x as QuizItem).questions.splice(qi, 1); }) : undefined} />
                ))}
                <Button type="button" variant="secondary" small onClick={() => setItem((x) => { (x as QuizItem).questions.push(blankQuestion()); })}>Add question</Button>
              </>
            )}
        </div>
      )}
    </div>
  );
}

export function ContentBuilder({ value, onChange }: { value: Content; onChange: (c: Content) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const mutate: Mutate = (fn) => { const c = structuredClone(value); fn(c); onChange(c); };
  const addItem = (si: number, item: Item) => {
    mutate((c) => {
      c.sections[si].items.push(item);
      const key = item.kind === 'lesson' ? 'lessons' : 'quizzes';
      c.completion[key].push(item.id);            // new items are required by default; untick to make optional
    });
    setOpenId(item.id);
  };
  const all = value.sections.flatMap((s) => s.items);

  return (
    <div className="builder">
      <div className="rule-bar">
        <span><strong>Completion rule:</strong> {value.completion.lessons.length} required lessons, {value.completion.quizzes.length} required quizzes. A learner completes the course and gets a certificate when all required items are done.</span>
        {all.length > 0 && <button type="button" className="link-btn" onClick={() => mutate((c) => {
          c.completion.lessons = all.filter((i) => i.kind === 'lesson').map((i) => i.id);
          c.completion.quizzes = all.filter((i) => i.kind === 'quiz').map((i) => i.id);
        })}>Require everything</button>}
      </div>
      {value.sections.map((s, si) => (
        <section key={s.id} className="section-edit">
          <div className="section-edit-head">
            <input className="section-title" aria-label={`Section ${si + 1} title`} placeholder={`Section ${si + 1} title`} value={s.title} onChange={(e) => mutate((c) => { c.sections[si].title = e.target.value; })} />
            <div className="item-tools">
              <button type="button" className="icon-btn" aria-label="Move section up" disabled={si === 0} onClick={() => mutate((c) => move(c.sections, si, -1))}>↑</button>
              <button type="button" className="icon-btn" aria-label="Move section down" disabled={si === value.sections.length - 1} onClick={() => mutate((c) => move(c.sections, si, 1))}>↓</button>
              <button type="button" className="icon-btn" aria-label="Delete section" onClick={() => {
                if (!confirm(`Delete section “${s.title || si + 1}” and everything in it?`)) return;
                mutate((c) => {
                  const ids = new Set(c.sections[si].items.map((i) => i.id));
                  c.sections.splice(si, 1);
                  c.completion.lessons = c.completion.lessons.filter((x) => !ids.has(x));
                  c.completion.quizzes = c.completion.quizzes.filter((x) => !ids.has(x));
                });
              }}>✕</button>
            </div>
          </div>
          {s.items.map((it, ii) => (
            <ItemEditor key={it.id} it={it} si={si} ii={ii} count={s.items.length} mutate={mutate} open={openId === it.id}
              toggle={() => setOpenId(openId === it.id ? null : it.id)}
              required={(it.kind === 'lesson' ? value.completion.lessons : value.completion.quizzes).includes(it.id)} />
          ))}
          <div className="row-gap">
            <Button type="button" variant="secondary" small onClick={() => addItem(si, blankLesson())}>Add lesson</Button>
            <Button type="button" variant="secondary" small onClick={() => addItem(si, blankQuiz())}>Add quiz</Button>
          </div>
        </section>
      ))}
      <Button type="button" variant="ghost" onClick={() => mutate((c) => { c.sections.push({ id: newId(), title: '', items: [] }); })}>Add section</Button>
    </div>
  );
}
