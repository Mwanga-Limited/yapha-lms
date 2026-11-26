import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';

const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a) }));
let user: Record<string, unknown> | null = null;
vi.mock('../auth', () => ({ useAuth: () => ({ user }) }));
const { CourseEditor } = await import('../pages/teacher/CourseEditor');
const { AdminCourse } = await import('../pages/admin/CourseView');

const teacher = { id: 't1', role: 'teacher', emailVerified: true, name: 'Tunde' };
const admin = { id: 'a1', role: 'admin', emailVerified: true, name: 'Ada' };
const content = { sections: [], completion: { lessons: [], quizzes: [] } };
const course = {
  id: 'c1', slug: 'algebra', title: 'Algebra', summary: 'Learn algebra', description: '', outline: 'Equations', category: 'Maths', level: 'beginner', language: 'English',
  thumbnailFileId: null, thumbnailUrl: null, status: 'published', publishedAt: null, createdAt: '', updatedAt: '', teacherId: 't1',
  price: 500_000, suggestedPrice: 500_000, currency: 'NGN',
};
const pending = { ...course, summary: 'A much better summary', level: 'intermediate' };
const get = (draft: object | null) => ({
  course, teacher: { id: 't1', name: 'Tunde', email: 't@x.dev' }, enrollments: 3, fileUrls: {},
  live: { id: 'v1', versionNo: 1, content, reviewedAt: '' }, draft, problems: [], reviews: [],
});
const revision = (status: string, details: object | null) => ({ id: 'v2', versionNo: 2, status, content, submittedAt: '2026-11-26T10:00:00Z', updatedAt: '', details });
const wrap = (path: string, route: string, el: React.ReactNode) => render(
  <ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={el} /></Routes></MemoryRouter></ToastProvider>,
);

beforeEach(() => { api.mockReset(); user = teacher; });

describe("editing a published course's details", () => {
  test('the form says changes need approval and shows the changes already waiting', async () => {
    api.mockImplementation(async (_e: string, action: string) => (action === 'get' ? get(revision('draft', pending)) : { ok: true }));
    wrap('/teach/courses/c1', '/teach/courses/:id', <CourseEditor />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Details' }));
    expect(screen.getByText(/reach learners only after an Admin approves them/)).toBeInTheDocument();
    expect(screen.getByText('You have changes waiting to be submitted.')).toBeInTheDocument();
    expect(screen.getByLabelText('Summary')).toHaveValue('A much better summary');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save details' })); });
    expect(api).toHaveBeenCalledWith('courses', 'updateMeta', expect.objectContaining({ id: 'c1', summary: 'A much better summary', level: 'intermediate' }));
    expect(await screen.findByText('Saved. Submit for review to make the changes live.')).toBeInTheDocument();
  });

  test('the form is locked while the changes are being reviewed', async () => {
    api.mockImplementation(async () => get(revision('in_review', pending)));
    wrap('/teach/courses/c1', '/teach/courses/:id', <CourseEditor />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Details' }));
    expect(screen.getByText(/Your changes are being reviewed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled();
  });

  test('an Admin editing a teacher\'s course gets a link back to the Admin view', async () => {
    user = admin;
    api.mockImplementation(async () => get(null));
    wrap('/teach/courses/c1', '/teach/courses/:id', <CourseEditor />);
    expect(await screen.findByRole('link', { name: 'Back to the Admin view' })).toHaveAttribute('href', '/admin/courses/c1');
  });
});

describe('the Admin reviewing an edit', () => {
  test('sees each changed detail next to the live one', async () => {
    user = admin;
    api.mockImplementation(async () => get(revision('in_review', pending)));
    wrap('/admin/courses/c1', '/admin/courses/:id', <AdminCourse />);
    const table = await screen.findByTestId('detail-changes');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['SummaryLearn algebraA much better summary', 'Levelbeginnerintermediate']);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  test('can open a live course in the editor', async () => {
    user = admin;
    api.mockImplementation(async (_e: string, action: string) => (action === 'get' ? get(null) : { learners: [] }));
    wrap('/admin/courses/c1', '/admin/courses/:id', <AdminCourse />);
    expect(await screen.findByRole('link', { name: 'Edit course' })).toHaveAttribute('href', '/teach/courses/c1');
  });
});
