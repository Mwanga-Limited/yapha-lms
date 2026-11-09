import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';

const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a) }));
const { QuizView } = await import('../pages/student/QuizView');

const quiz = { id: 'q1', title: 'Check-in', description: '', questions: [
  { id: 'a', type: 'single', prompt: 'Pick one', options: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] },
] };
const state = (over: object) => ({ attemptsUsed: 2, attemptsLeft: 1, maxAttempts: 3, passMark: 70, lockedUntil: null, passed: false, score: 40, ...over });

function show(s: object) {
  api.mockResolvedValue({ quiz, state: state(s), attempts: [] });
  return render(<ToastProvider><QuizView courseId="c1" quizId="q1" onSubmitted={() => {}} /></ToastProvider>);
}

beforeEach(() => api.mockReset());

describe('the quiz screen shows the learner their own score', () => {
  test('"Your score", never "Best score"', async () => {
    show({ score: 40 });
    expect(await screen.findByText('Your score')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.queryByText(/best score/i)).toBeNull();
  });

  test('after passing: "You scored …"', async () => {
    show({ passed: true, attemptsLeft: 0, score: 80 });
    expect(await screen.findByText('You scored 80%.')).toBeInTheDocument();
    expect(screen.queryByText(/best score/i)).toBeNull();
  });

  test('no score shown before the first attempt', async () => {
    show({ attemptsUsed: 0, attemptsLeft: 3, score: null });
    expect(await screen.findByText('Pass mark')).toBeInTheDocument();
    expect(screen.queryByText('Your score')).toBeNull();
  });
});
