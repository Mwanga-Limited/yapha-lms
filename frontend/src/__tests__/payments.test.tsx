import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { formatMoney } from '../money';

const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a) }));
let user: Record<string, unknown> | null = null;
vi.mock('../auth', () => ({ useAuth: () => ({ user }) }));
const { CourseDetail } = await import('../pages/CourseDetail');
const { PaymentResult } = await import('../pages/student/PaymentResult');
const { CourseCard } = await import('../components/CourseCard');
const { PaymentSettings } = await import('../components/PaymentSettings');

const student = { id: 'u1', role: 'student', emailVerified: true, name: 'Bola Buyer' };
const course = (price: number) => ({
  id: 'c1', title: 'Paid Accounting', summary: 'Books', description: '', outline: '', category: 'Business', level: 'beginner', language: 'English',
  thumbnailFileId: null, thumbnailUrl: null, status: 'published', publishedAt: null, createdAt: '', updatedAt: '', teacherId: 't1',
  price, suggestedPrice: price, currency: 'NGN', learners: 3,
});
const detail = (price: number, over: object = {}) => ({
  course: course(price), outline: [], teacher: { id: 't1', name: 'Tunde', bio: null, expertise: null, photoUrl: null, courses: 1 },
  viewer: { enrolled: false, completed: false, canManage: false, signedIn: true, emailVerified: true }, paymentsReady: true, ...over,
});
const wrap = (path: string, el: React.ReactNode, route: string) => render(
  <ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={el} /><Route path="/learn/:id" element={<p>player</p>} /></Routes></MemoryRouter></ToastProvider>,
);

beforeEach(() => { api.mockReset(); user = student; });

describe('prices', () => {
  test('are shown in naira on course cards; nothing is ever shown as free', () => {
    expect(formatMoney(500_000, 'NGN')).toBe('₦5,000');
    expect(formatMoney(1_250_050, 'NGN')).toBe('₦12,500.5');
    expect(formatMoney(0, 'NGN', { unset: 'Not set' })).toBe('Not set');
    render(<MemoryRouter><CourseCard c={{ ...course(500_000), teacherName: 'Tunde', status: 'published' } as never} /></MemoryRouter>);
    expect(screen.getByText('₦5,000')).toBeInTheDocument();
    expect(screen.queryByText(/free/i)).toBeNull();
  });
});

describe('buying a course from its page', () => {
  test('a paid course shows its price and a Buy button that goes to Paystack checkout', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    api.mockImplementation(async (_e: string, action: string) => {
      if (action === 'detail') return detail(500_000);
      if (action === 'checkout') return { authorizationUrl: 'https://checkout.paystack.com/ALPHA-abc', reference: 'ALPHA-abc' };
      throw new Error(action);
    });
    wrap('/courses/c1', <CourseDetail />, '/courses/:id');
    const buy = await screen.findByRole('button', { name: 'Enrol for ₦5,000' });
    expect(screen.getByTestId('price')).toHaveTextContent('₦5,000');
    expect(screen.queryByText(/free/i)).toBeNull();
    await act(async () => { fireEvent.click(buy); });
    expect(api).toHaveBeenCalledWith('payments', 'checkout', { courseId: 'c1' });
    expect(api).not.toHaveBeenCalledWith('learn', 'enrol', expect.anything());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.paystack.com/ALPHA-abc'));
    vi.unstubAllGlobals();
  });

  test('every course is paid: a course without a price has no Enrol button and nothing is free', async () => {
    api.mockImplementation(async () => detail(0));
    wrap('/courses/c1', <CourseDetail />, '/courses/:id');
    expect(await screen.findByText(/doesn't have a price/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enrol/ })).toBeNull();
    expect(screen.queryByText(/free/i)).toBeNull();
    expect(api).not.toHaveBeenCalledWith('learn', 'enrol', expect.anything());
  });

  test('when the organisation has not set up Paystack, buying is disabled with an explanation', async () => {
    api.mockImplementation(async () => detail(500_000, { paymentsReady: false }));
    wrap('/courses/c1', <CourseDetail />, '/courses/:id');
    expect(await screen.findByRole('button', { name: 'Enrol for ₦5,000' })).toBeDisabled();
    expect(screen.getByText(/payments are not set up/)).toBeInTheDocument();
  });

  test('a learner who already paid sees "Continue learning", not Buy', async () => {
    api.mockImplementation(async () => detail(500_000, { viewer: { enrolled: true, completed: false, canManage: false, signedIn: true, emailVerified: true } }));
    wrap('/courses/c1', <CourseDetail />, '/courses/:id');
    expect(await screen.findByRole('link', { name: 'Continue learning' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enrol for ₦/ })).toBeNull();
  });
});

describe('coming back from Paystack', () => {
  const back = (status: string, extra: object = {}) => {
    api.mockResolvedValue({ payment: { reference: 'ALPHA-abc', status, amount: 500_000, currency: 'NGN', failure: null, ...extra }, courseId: 'c1' });
    return wrap('/payment?trxref=ALPHA-abc&reference=ALPHA-abc', <PaymentResult />, '/payment');
  };
  test('the server checks the payment with Paystack; on success the learner can start', async () => {
    back('success');
    expect(await screen.findByText('Payment successful')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('payments', 'verify', { reference: 'ALPHA-abc' });
    expect(screen.getByText(/We received ₦5,000/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start learning' })).toHaveAttribute('href', '/learn/c1');
  });
  test('a failed payment offers to try again', async () => {
    back('failed', { failure: 'Declined' });
    expect(await screen.findByText('Payment not completed')).toBeInTheDocument();
    expect(screen.getByText(/Declined/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/courses/c1');
  });
  test('an unfinished payment can be checked again', async () => {
    back('pending');
    expect(await screen.findByText('Payment not finished')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(api).toHaveBeenCalledTimes(2);
  });
  test('if the check fails the learner is told not to pay twice', async () => {
    api.mockRejectedValue(new Error('network'));
    wrap('/payment?reference=ALPHA-abc', <PaymentResult />, '/payment');
    expect(await screen.findByText("We couldn't confirm your payment yet")).toBeInTheDocument();
    expect(screen.getByText(/don't pay again/)).toBeInTheDocument();
  });
});

describe("the Admin's Paystack settings", () => {
  test('connecting sends both keys; afterwards only a hint of the secret key is shown', async () => {
    let connected = false;
    api.mockImplementation(async (_e: string, action: string) => {
      if (action === 'account') return connected
        ? { connected: true, account: { publicKey: 'pk_test_aaaa', secretKeyHint: 'sk_test_…bbbb', liveMode: false, updatedAt: new Date().toISOString() }, currency: 'NGN', webhookUrl: 'https://x/api/alpha/payments/webhook' }
        : { connected: false, account: null, currency: 'NGN', webhookUrl: 'https://x/api/alpha/payments/webhook' };
      if (action === 'saveAccount') { connected = true; return { ok: true, liveMode: false }; }
      throw new Error(action);
    });
    render(<ToastProvider><PaymentSettings /></ToastProvider>);
    fireEvent.change(await screen.findByLabelText('Public key'), { target: { value: 'pk_test_aaaa' } });
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'sk_test_bbbb' } });
    expect(screen.getByText('https://x/api/alpha/payments/webhook')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Paystack' })); });
    expect(api).toHaveBeenCalledWith('payments', 'saveAccount', { publicKey: 'pk_test_aaaa', secretKey: 'sk_test_bbbb' });
    expect(await screen.findByText('Paystack connected in test mode')).toBeInTheDocument();
    expect(screen.getByText('sk_test_…bbbb')).toBeInTheDocument();
    expect(screen.queryByText('sk_test_bbbb')).toBeNull();
    expect(screen.queryByLabelText('Secret key')).toBeNull();
  });
});
