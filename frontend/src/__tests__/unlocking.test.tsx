import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { UnlockDelayField, delayProblem, describeDelay, describeUnlock } from '../components/UnlockSetting';

const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a) }));
vi.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'a1', role: 'admin', emailVerified: true } }), useTenant: () => ({ slug: 'acme' }) }));
const { Player } = await import('../pages/student/Player');
const { AdminCourse } = await import('../pages/admin/CourseView');

const lesson = (id: string, title: string, extra = {}) => ({ id, kind: 'lesson', title, type: 'text', required: true, done: false, locked: false, ...extra });
const playerData = (outline: unknown[]) => ({
  course: { id: 'c1', slug: 'algebra', title: 'Algebra', teacherName: 'Tunde', status: 'published' }, outline,
  progress: { total: 3, done: 0, percent: 0 }, resumeItemId: null, completedAt: null, certificate: null, unlock: { afterHours: null, enrolledAt: '' },
});
const openPlayer = (item?: string) => render(
  <ToastProvider><MemoryRouter initialEntries={[`/learn/algebra${item ? `?item=${item}` : ''}`]}><Routes><Route path="/learn/:courseRef" element={<Player />} /></Routes></MemoryRouter></ToastProvider>,
);
const textLesson = (id: string) => ({ lesson: { id, title: id, type: 'text', body: 'Hello.', videoUrl: null, fileUrl: null, fileName: null, durationMin: 1 }, completed: false, positionSec: 0, watch: null });

beforeEach(() => { api.mockReset(); });

describe('describing unlocking', () => {
  test('delays read naturally and invalid ones are explained', () => {
    expect(describeDelay(48)).toBe('2 days');
    expect(describeDelay(24)).toBe('1 day');
    expect(describeDelay(36)).toBe('36 hours');
    expect(describeUnlock(null)).toMatch(/opens as soon as a learner enrols. Each section opens when the one before it is complete/);
    expect(describeUnlock(72)).toMatch(/opens 3 days after a learner enrols/);
    expect(delayProblem('', 'days')).toMatch(/whole number of days/);
    expect(delayProblem('1.5', 'hours')).toMatch(/whole number/);
    expect(delayProblem('366', 'days')).toMatch(/under a year/);
    expect(delayProblem('2', 'days')).toBeNull();
  });

  test('the delay field sends hours: none, or so many hours or days', () => {
    const seen: (number | null)[] = [];
    function Host() { const [v, setV] = useState<number | null>(null); return <UnlockDelayField value={v} onChange={(h) => { seen.push(h); setV(h); }} />; }
    render(<Host />);
    fireEvent.click(screen.getByLabelText('After a delay'));
    expect(seen.at(-1)).toBe(48);   // starts at 2 days
    fireEvent.change(screen.getByLabelText('Delay'), { target: { value: '3' } });
    expect(seen.at(-1)).toBe(72);
    fireEvent.change(screen.getByLabelText('Delay unit'), { target: { value: 'hours' } });
    expect(seen.at(-1)).toBe(3);
    fireEvent.change(screen.getByLabelText('Delay'), { target: { value: '0' } });
    expect(screen.getByText(/whole number of hours/)).toBeInTheDocument();
    expect(seen.at(-1)).toBe(3);   // invalid input isn't sent
    fireEvent.click(screen.getByLabelText('As soon as the learner enrols'));
    expect(seen.at(-1)).toBeNull();
  });
});

describe('locked sections in the course player', () => {
  test('a section locked until the one before it is complete shows why, and its lessons are not loaded', async () => {
    api.mockImplementation(async (_e: string, action: string, data: { lessonId?: string }) => {
      if (action === 'player') return playerData([
        { id: 's1', title: 'Basics', locked: null, items: [lesson('t1', 'Read me')] },
        { id: 's2', title: 'Watch', locked: { reason: 'completion', opensAt: null, after: 'Basics' }, items: [lesson('t2', 'Next lesson', { locked: true })] },
      ]);
      if (action === 'lesson') return textLesson(data.lessonId!);
      throw new Error(action);
    });
    openPlayer('t2');
    expect(await screen.findByTestId('locked-panel')).toHaveTextContent('Complete every lesson and pass every quiz in “Basics” to unlock it.');
    expect(screen.getByText('Complete “Basics” first')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('learn', 'lesson', expect.anything());
  });

  test('the player starts at the first open lesson', async () => {
    api.mockImplementation(async (_e: string, action: string, data: { lessonId?: string }) => {
      if (action === 'player') return playerData([
        { id: 's1', title: 'Basics', locked: null, items: [lesson('t1', 'Read me')] },
        { id: 's2', title: 'Watch', locked: { reason: 'completion', opensAt: null, after: 'Basics' }, items: [lesson('t2', 'Next lesson', { locked: true })] },
      ]);
      if (action === 'lesson') return textLesson(data.lessonId!);
      throw new Error(action);
    });
    openPlayer();
    expect(await screen.findByText('Hello.')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('learn', 'lesson', { courseId: 'c1', lessonId: 't1' });
  });

  test('with a delay, every section shows when the course opens', async () => {
    const opensAt = '2026-12-01T09:00:00.000Z';
    api.mockImplementation(async () => playerData([
      { id: 's1', title: 'Basics', locked: { reason: 'time', opensAt, after: null }, items: [lesson('t1', 'Read me', { locked: true })] },
      { id: 's2', title: 'Watch', locked: { reason: 'time', opensAt, after: null }, items: [lesson('t2', 'Next', { locked: true })] },
    ]));
    openPlayer();
    expect(await screen.findByText(/Until then you can open the free preview lessons/)).toBeInTheDocument();
    expect(screen.getByTestId('locked-panel')).toHaveTextContent('This course opens soon');
    expect(screen.getAllByText(/^Opens /)).toHaveLength(2);
  });
});

describe("the Admin's unlocking setting", () => {
  const content = (afterHours: number | null) => ({ sections: [], completion: { lessons: [], quizzes: [] }, unlock: { afterHours } });
  const get = (live: number | null, draft?: number | null) => ({
    course: { id: 'c1', slug: 'algebra', title: 'Algebra', summary: '', description: '', outline: '', category: 'Maths', level: 'beginner', language: 'English',
      thumbnailFileId: null, thumbnailUrl: null, status: 'published', publishedAt: null, createdAt: '', updatedAt: '', teacherId: 't1', price: 500_000, suggestedPrice: 500_000, currency: 'NGN' },
    teacher: { id: 't1', name: 'Tunde', email: 't@x.dev' }, enrollments: 0, fileUrls: {},
    live: { id: 'v1', versionNo: 1, content: content(live), reviewedAt: '' },
    draft: draft === undefined ? null : { id: 'v2', versionNo: 2, status: 'draft', content: content(draft), submittedAt: null, updatedAt: '' },
    problems: [], reviews: [],
  });
  const openAdmin = () => render(<ToastProvider><MemoryRouter initialEntries={['/admin/courses/c1']}><Routes><Route path="/admin/courses/:id" element={<AdminCourse />} /></Routes></MemoryRouter></ToastProvider>);

  test('sets a delay on the live course directly', async () => {
    api.mockImplementation(async (_e: string, action: string) => (action === 'get' ? get(null) : { unlock: { afterHours: 48 } }));
    openAdmin();
    const panel = await screen.findByTestId('unlock-editor');
    expect(panel).toHaveTextContent('The course opens as soon as a learner enrols.');
    fireEvent.click(screen.getByLabelText('After a delay'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save unlocking' })); });
    expect(api).toHaveBeenCalledWith('courses', 'setUnlock', { id: 'c1', unlock: { afterHours: 48 } });
  });

  test("sees a teacher's proposed change that waits for approval", async () => {
    api.mockImplementation(async () => get(null, 24));
    openAdmin();
    expect(await screen.findByText(/The teacher's revision changes this to: The course opens 1 day after a learner enrols/)).toBeInTheDocument();
  });
});
