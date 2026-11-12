import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';

const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a), getTenantSlug: () => 'yapha' }));
const setUser = vi.fn();
let signedIn: Record<string, unknown> | null = null;
vi.mock('../auth', () => ({
  useAuth: () => ({ user: signedIn, setUser, googleClientId: null }),
  useTenant: () => ({ name: 'Yapha', access: { signup: 'open', allowedDomains: [] }, auth: { google: false } }),
}));
const { Register } = await import('../pages/auth/Register');
const { ReferralPanel } = await import('../components/ReferralPanel');
const { AdminReferrals } = await import('../pages/admin/Referrals');
const { CourseCard } = await import('../components/CourseCard');
const { CourseDetail } = await import('../pages/CourseDetail');
const { rememberReferral, rememberedReferral } = await import('../referral');

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const at = (path: string, route: string, el: React.ReactNode) => render(
  <ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={<>{el}<Where /></>} /><Route path="*" element={<Where />} /></Routes></MemoryRouter></ToastProvider>,
);
const course = { id: '6f1c0e1a-1111-4222-8333-944455556666', slug: 'bookkeeping-basics', title: 'Bookkeeping Basics', summary: '', description: '', outline: '', category: 'Business',
  level: 'beginner', language: 'English', thumbnailFileId: null, thumbnailUrl: null, status: 'published', publishedAt: null, createdAt: '', updatedAt: '', teacherId: 't1',
  price: 500_000, suggestedPrice: 500_000, currency: 'NGN', learners: 0 };
const detail = { course, outline: [], teacher: { id: 't1', name: 'Tunde', bio: null, expertise: null, photoUrl: null, courses: 1 },
  viewer: { enrolled: false, completed: false, canManage: false, signedIn: true, emailVerified: true }, paymentsReady: true };

beforeEach(() => { api.mockReset(); localStorage.clear(); signedIn = null; });

describe('sign-up has no referral code', () => {
  test('the sign-up form has no referral field and sends no code', async () => {
    api.mockResolvedValue({ user: { id: 'u9', role: 'student' } });
    at('/register?ref=AB3K7Q2M', '/register', <Register />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign up with email' }));
    expect(screen.queryByLabelText(/Referral code/)).toBeNull();
  });
});

describe('using a referral code when enrolling', () => {
  const assign = vi.fn();
  beforeEach(() => {
    signedIn = { id: 'u1', role: 'student', emailVerified: true, name: 'Bola' };
    assign.mockReset();
    vi.stubGlobal('location', { ...window.location, assign });
    api.mockImplementation(async (_e: string, action: string) => (action === 'detail' ? detail : { authorizationUrl: 'https://checkout.paystack.com/x', reference: 'x' }));
  });

  test('the learner can type a code next to the Enrol button; it is sent with the payment', async () => {
    at('/courses/bookkeeping-basics', '/courses/:courseRef', <CourseDetail />);
    const box = await screen.findByLabelText('Referral code (optional)', {}, { timeout: 3000 });
    fireEvent.change(box, { target: { value: 'py8efb2q' } });
    expect(box).toHaveValue('PY8EFB2Q');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enrol for ₦5,000' })); });
    expect(api).toHaveBeenCalledWith('payments', 'checkout', { courseId: course.id, referralCode: 'PY8EFB2Q' });
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });

  test('a code from a referral link is filled in already', async () => {
    rememberReferral('zz9wq4rt');
    at('/courses/bookkeeping-basics', '/courses/:courseRef', <CourseDetail />);
    expect(await screen.findByLabelText('Referral code (optional)', {}, { timeout: 3000 })).toHaveValue('ZZ9WQ4RT');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enrol for ₦5,000' })); });
    expect(api).toHaveBeenCalledWith('payments', 'checkout', { courseId: course.id, referralCode: 'ZZ9WQ4RT' });
    expect(rememberedReferral()).toBe(''); // used once, then forgotten
  });

  test('without a code, none is sent', async () => {
    at('/courses/bookkeeping-basics', '/courses/:courseRef', <CourseDetail />);
    await screen.findByTestId('price', {}, { timeout: 3000 });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Enrol for ₦5,000' }, { timeout: 3000 })); });
    expect(api).toHaveBeenCalledWith('payments', 'checkout', { courseId: course.id, referralCode: undefined });
  });
});

describe("a teacher's or student's own referrals", () => {
  test('shows their code and link to copy, the totals, and per course how many enrolled with the code and who', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    api.mockResolvedValue({ code: 'AB3K7Q2M', link: 'http://localhost:5173/yapha?ref=AB3K7Q2M', count: 3, courses: [
      { courseId: 'c2', course: 'Excel for Beginners', count: 2, referrals: [
        { id: 'e1', name: 'Bola', email: 'b***@test.dev', enrolledAt: '2026-11-10T11:00:00Z' }, { id: 'e2', name: 'Dayo', email: 'd***@test.dev', enrolledAt: '2026-11-09T10:00:00Z' }] },
      { courseId: 'c1', course: 'Bookkeeping Basics', count: 1, referrals: [{ id: 'e3', name: 'Bola', email: 'b***@test.dev', enrolledAt: '2026-11-10T10:00:00Z' }] }] });
    render(<ToastProvider><ReferralPanel /></ToastProvider>);
    expect(await screen.findByText('AB3K7Q2M')).toBeInTheDocument();
    expect(screen.getByTestId('referral-count')).toHaveTextContent('3');
    expect(screen.getByTestId('referral-courses')).toHaveTextContent('2');
    expect(screen.queryByText('People referred')).toBeNull();
    const excel = screen.getByTestId('course-referrals-c2');
    expect(excel).toHaveTextContent('Excel for Beginners');
    expect(excel).toHaveTextContent('2 enrolments');
    expect(excel).toHaveTextContent('d***@test.dev');
    expect(screen.getByTestId('course-referrals-c1')).toHaveTextContent('1 enrolment');
    expect(screen.getByTestId('course-referrals-c1')).not.toHaveTextContent('Dayo');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy code' })); });
    expect(writeText).toHaveBeenCalledWith('AB3K7Q2M');
  });
});

describe("the Admin's referrals page", () => {
  test('lists each member whose code was used with the count; opening one shows each email and course', async () => {
    api.mockResolvedValue({
      referrers: [{ id: 'r1', name: 'Ada Referrer', email: 'ada@test.dev', memberCode: 'YAPHA-000002', role: 'teacher', code: 'AB3K7Q2M', count: 2, courses: [
        { courseId: 'c1', course: 'Bookkeeping Basics', count: 1, referrals: [{ id: 'e1', name: 'Bola', email: 'bola@test.dev', enrolledAt: '2026-11-10T10:00:00Z' }] },
        { courseId: 'c2', course: 'Excel for Beginners', count: 1, referrals: [{ id: 'e2', name: 'Dayo', email: 'dayo@test.dev', enrolledAt: '2026-11-09T10:00:00Z' }] }] }],
      total: 1, pageSize: 25, totals: { referrals: 2, referrers: 1 },
    });
    at('/admin/referrals', '/admin/referrals', <AdminReferrals />);
    expect(await screen.findByText('Ada Referrer')).toBeInTheDocument();
    expect(screen.getByText('Enrolments with a referral code').nextSibling).toHaveTextContent('2');
    expect(screen.queryByText('bola@test.dev')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show who enrolled' }));
    const table = screen.getByTestId('referees-AB3K7Q2M');
    expect(table).toHaveTextContent('bola@test.dev');
    expect(within(table).getByTestId('course-referrals-c2')).toHaveTextContent('Excel for Beginners');
    expect(within(table).getByTestId('course-referrals-c2')).toHaveTextContent('dayo@test.dev');
    expect(screen.queryByText(/valid/i)).toBeNull();
  });
});

describe('course web addresses use the slug', () => {
  test('course cards link to /courses/<slug>', () => {
    render(<MemoryRouter><CourseCard c={{ ...course, teacherName: 'Tunde' } as never} /></MemoryRouter>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/courses/bookkeeping-basics');
  });
  test('an old link with the course ID moves to the slug address', async () => {
    api.mockResolvedValue({ course, outline: [], teacher: { id: 't1', name: 'Tunde', bio: null, expertise: null, photoUrl: null, courses: 1 },
      viewer: { enrolled: false, completed: false, canManage: false, signedIn: false, emailVerified: false }, paymentsReady: true });
    at(`/courses/${course.id}`, '/courses/:courseRef', <CourseDetail />);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/courses/bookkeeping-basics'));
    expect(api).toHaveBeenCalledWith('courses', 'detail', { id: course.id });
  });
});
