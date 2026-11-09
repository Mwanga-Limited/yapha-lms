import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { LessonPayload } from '../api';
import { LessonView } from '../components/LessonView';

const videoLesson = (over: Partial<LessonPayload> = {}): LessonPayload => ({
  id: 'l2', title: 'Watch this', type: 'video', body: '', videoUrl: null, fileUrl: '/api/t/acme/files/v1?exp=1&sig=x', fileName: 'intro.mp4', durationMin: 1, ...over,
});

/** jsdom has no media engine: set the time and length the browser would report. */
function at(video: HTMLVideoElement, currentTime: number, duration = 60) {
  Object.defineProperty(video, 'currentTime', { configurable: true, value: currentTime });
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
}

describe('a video lesson reports what is watched', () => {
  test('reports the position and the video length when playback starts', () => {
    const onPosition = vi.fn();
    const { container } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 0);
    fireEvent.play(video);
    expect(onPosition).toHaveBeenCalledWith(0, 60);
  });

  test('while playing, reports every 5 seconds, not on every tick', () => {
    const onPosition = vi.fn();
    const { container } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 0); fireEvent.play(video);
    at(video, 2); fireEvent.timeUpdate(video);
    at(video, 4); fireEvent.timeUpdate(video);
    expect(onPosition).toHaveBeenCalledTimes(1);
    at(video, 5.2); fireEvent.timeUpdate(video);
    expect(onPosition).toHaveBeenLastCalledWith(5.2, 60);
    expect(onPosition).toHaveBeenCalledTimes(2);
  });

  test('reports on pause, and reports the full length when the video ends', () => {
    const onPosition = vi.fn();
    const { container } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 20); fireEvent.pause(video);
    expect(onPosition).toHaveBeenLastCalledWith(20, 60);
    at(video, 59.6); fireEvent.ended(video);
    expect(onPosition).toHaveBeenLastCalledWith(60, 60);
  });

  test('a YouTube video is embedded with playback reporting, and its messages are passed on', () => {
    const onPosition = vi.fn();
    const { container } = render(<LessonView lesson={videoLesson({ fileUrl: null, videoUrl: 'https://www.youtube.com/watch?v=abc123' })} onPosition={onPosition} />);
    const frame = container.querySelector('iframe')!;
    expect(frame.src).toContain('enablejsapi=1');
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://www.youtube-nocookie.com', source: frame.contentWindow,
      data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 0, duration: 300, playerState: 1 } }),
    }));
    expect(onPosition).toHaveBeenCalledWith(0, 300);
    // A message that claims to be the player but comes from another site is ignored.
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example.com', source: frame.contentWindow,
      data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 300, duration: 300, playerState: 0 } }),
    }));
    expect(onPosition).toHaveBeenCalledTimes(1);
  });
});

describe('nothing watched is lost when the learner leaves', () => {
  test('leaving the lesson mid-video sends the seconds watched since the last report', () => {
    const onPosition = vi.fn();
    const { container, unmount } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 0); fireEvent.play(video);
    at(video, 3); fireEvent.timeUpdate(video);   // under 5 s: not reported yet
    expect(onPosition).toHaveBeenCalledTimes(1);
    unmount();
    expect(onPosition).toHaveBeenLastCalledWith(3, 60, true);
  });

  test('switching tab or closing the page sends it too', () => {
    const onPosition = vi.fn();
    const { container } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 0); fireEvent.play(video);
    at(video, 4); fireEvent.timeUpdate(video);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onPosition).toHaveBeenLastCalledWith(4, 60, true);
    at(video, 4.5); fireEvent.timeUpdate(video);
    window.dispatchEvent(new Event('pagehide'));
    expect(onPosition).toHaveBeenLastCalledWith(4.5, 60, true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  test('nothing extra is sent when the last position was already reported', () => {
    const onPosition = vi.fn();
    const { container, unmount } = render(<LessonView lesson={videoLesson()} onPosition={onPosition} />);
    const video = container.querySelector('video')!;
    at(video, 20); fireEvent.pause(video);
    unmount();
    expect(onPosition).toHaveBeenCalledTimes(1);
  });
});

describe('other lessons', () => {
  test('a text lesson shows its text and no video', () => {
    const { container } = render(<LessonView lesson={{ id: 'l1', title: 'Welcome', type: 'text', body: 'Hello and welcome.\n\nSecond paragraph.', videoUrl: null, fileUrl: null, fileName: null, durationMin: 3 }} />);
    expect(screen.getByText('Hello and welcome.')).toBeInTheDocument();
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });
  test('a file lesson offers a download', () => {
    render(<LessonView lesson={{ id: 'l3', title: 'Worksheet', type: 'file', body: '', videoUrl: null, fileUrl: '/api/t/acme/files/f1?exp=1&sig=x', fileName: 'sheet.pdf', durationMin: null }} />);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', expect.stringContaining('&download'));
  });
});
