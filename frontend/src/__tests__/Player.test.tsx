import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui';

// The course player talks to the API through api(); the tests answer for the server.
const api = vi.fn();
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: (...a: unknown[]) => api(...a) }));
const { Player } = await import('../pages/student/Player');

const outline = [{
  id: 's1', title: 'Getting started', items: [
    { id: 'l1', kind: 'lesson', title: 'Welcome', type: 'text', required: true, done: false },
    { id: 'l2', kind: 'lesson', title: 'Watch this', type: 'video', required: true, done: false },
    { id: 'q1', kind: 'quiz', title: 'Check-in', required: true, done: false },
  ],
}];
const player = { course: { id: 'c1', title: 'Video Course', teacherName: 'Tunde', status: 'published' }, outline, progress: { total: 3, done: 0, percent: 0 }, resumeItemId: null, completedAt: null, certificate: null };
const lessons: Record<string, unknown> = {
  l1: { lesson: { id: 'l1', title: 'Welcome', type: 'text', body: 'Hello.', videoUrl: null, fileUrl: null, fileName: null, durationMin: 2 }, completed: false, positionSec: 0, watch: null },
  l2: { lesson: { id: 'l2', title: 'Watch this', type: 'video', body: '', videoUrl: null, fileUrl: '/api/acme/files/v?exp=1&sig=x', fileName: 'v.mp4', durationMin: 1 }, completed: false, positionSec: 0,
    watch: { watchedSec: 0, durationSec: 0, percent: 0, requiredPercent: 90 } },
};

function open(item: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/learn/c1?item=${item}`]}>
        <Routes><Route path="/learn/:courseId" element={<Player />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

let savePositionReply: unknown;
beforeEach(() => {
  api.mockReset();
  savePositionReply = { ok: true, watch: { watchedSec: 0, durationSec: 60, percent: 0, requiredPercent: 90 }, completed: false };
  api.mockImplementation(async (_ep: string, action: string, data: { lessonId?: string }) => {
    if (action === 'player') return structuredClone(player);
    if (action === 'lesson') return structuredClone(lessons[data.lessonId!]);
    if (action === 'savePosition') return savePositionReply;
    if (action === 'completeLesson') return { progress: { total: 3, done: 1, percent: 33 }, certificate: null };
    throw new Error(`unexpected ${action}`);
  });
});

describe('video lessons in the course player', () => {
  test('have no "Mark as complete" button; they show how much is watched instead', async () => {
    open('l2');
    expect(await screen.findByTestId('watch-progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as complete' })).toBeNull();
    expect(screen.getByText('Watch the video to complete this lesson')).toBeInTheDocument();
  });

  test('playing the video reports the position and length, and the watched share updates', async () => {
    const { container } = open('l2');
    await screen.findByTestId('watch-progress');
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 0 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    savePositionReply = { ok: true, watch: { watchedSec: 33, durationSec: 60, percent: 55, requiredPercent: 90 }, completed: false };
    await act(async () => { fireEvent.play(video); });
    expect(api).toHaveBeenCalledWith('learn', 'savePosition', { courseId: 'c1', lessonId: 'l2', positionSec: 0, durationSec: 60 }, { keepalive: false });
    expect(await screen.findByText('55% watched')).toBeInTheDocument();
    expect(screen.queryByText(/90%/)).toBeNull();
  });

  test('when the server says the video is watched, the lesson shows as completed with a way on', async () => {
    const { container } = open('l2');
    await screen.findByTestId('watch-progress');
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 60 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    savePositionReply = { ok: true, completed: true, watch: { watchedSec: 58, durationSec: 60, percent: 97, requiredPercent: 90 },
      progress: { total: 3, done: 1, percent: 33 }, certificate: null };
    await act(async () => { fireEvent.ended(video); });
    expect(await screen.findByText('✓ Completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next: Check-in' })).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('learn', 'completeLesson', expect.anything());
  });
});

describe('no watching is lost when the learner moves on', () => {
  test('going to the next lesson mid-video saves the last seconds against the video, not the next lesson', async () => {
    const { container } = open('l2');
    await screen.findByTestId('watch-progress');
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
    await act(async () => { fireEvent.play(video); });
    video.currentTime = 13; await act(async () => { fireEvent.timeUpdate(video); });   // reported (5 s rule)
    video.currentTime = 16; await act(async () => { fireEvent.timeUpdate(video); });   // not yet reported
    api.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Check-in/ })); });
    expect(api).toHaveBeenCalledWith('learn', 'savePosition', { courseId: 'c1', lessonId: 'l2', positionSec: 16, durationSec: 60 }, { keepalive: true });
    expect(api).not.toHaveBeenCalledWith('learn', 'savePosition', expect.objectContaining({ lessonId: 'q1' }), expect.anything());
  });
});

describe('text lessons in the course player', () => {
  test('still have "Mark as complete"', async () => {
    open('l1');
    const btn = await screen.findByRole('button', { name: 'Mark as complete' });
    expect(screen.queryByTestId('watch-progress')).toBeNull();
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(api).toHaveBeenCalledWith('learn', 'completeLesson', { courseId: 'c1', lessonId: 'l1' }));
  });
});
