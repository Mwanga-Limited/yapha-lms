import { describe, expect, test } from 'vitest';
import { REPORT_EVERY_SEC, embedUrl, listenMessages, parseEmbedMessage, shouldReport, watchLabel } from '../watch';

describe('when the player reports its position', () => {
  test('always on the first report, and on play, pause and end (forced)', () => {
    expect(shouldReport(null, 0)).toBe(true);
    expect(shouldReport(12, 12.5, true)).toBe(true);
  });
  test(`while playing, only every ${REPORT_EVERY_SEC} seconds of movement`, () => {
    expect(shouldReport(10, 12)).toBe(false);
    expect(shouldReport(10, 10 + REPORT_EVERY_SEC)).toBe(true);
    expect(shouldReport(30, 10)).toBe(true);   // jumped back: report the new position
  });
});

describe('the watched label under a video', () => {
  test('before the length is known', () => {
    expect(watchLabel(null)).toBe('Watch the video to complete this lesson');
  });
    test('shows how much is watched, without the share needed to complete', () => {
    expect(watchLabel({ watchedSec: 31, durationSec: 50, percent: 62, requiredPercent: 90 }))
      .toBe('62% watched');
  });
});

describe('embedded video links', () => {
  test('YouTube links become a nocookie embed that reports playback', () => {
    const u = embedUrl('https://www.youtube.com/watch?v=abc123', 42.7, 'http://localhost:5173')!;
    expect(u).toContain('https://www.youtube-nocookie.com/embed/abc123');
    expect(u).toContain('start=42');
    expect(u).toContain('enablejsapi=1');
    expect(u).toContain('origin=http%3A%2F%2Flocalhost%3A5173');
    expect(embedUrl('https://youtu.be/xyz', 0)).toContain('/embed/xyz');
  });
  test('Vimeo links become a player embed', () => {
    expect(embedUrl('https://vimeo.com/76979871', 10)).toBe('https://player.vimeo.com/video/76979871?api=1#t=10s');
  });
  test('other links (an .mp4 file) are not embeds: they play in the built-in player', () => {
    expect(embedUrl('https://example.com/video.mp4', 0)).toBeNull();
    expect(embedUrl('not a url', 0)).toBeNull();
  });
  test('the right "start reporting" messages are sent to each kind of embed', () => {
    expect(listenMessages('https://www.youtube-nocookie.com/embed/x')).toEqual([JSON.stringify({ event: 'listening', id: 1, channel: 'widget' })]);
    expect(listenMessages('https://player.vimeo.com/video/1').map((m) => JSON.parse(m).value)).toEqual(['timeupdate', 'pause', 'ended', 'play']);
  });
});

describe('playback messages from embedded players', () => {
  test('YouTube: playing, paused and ended', () => {
    const msg = (playerState: number) => JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5, duration: 300, playerState } });
    expect(parseEmbedMessage('https://www.youtube-nocookie.com', msg(1))).toEqual({ positionSec: 12.5, durationSec: 300, state: 'playing' });
    expect(parseEmbedMessage('https://www.youtube.com', msg(2))?.state).toBe('paused');
    expect(parseEmbedMessage('https://www.youtube-nocookie.com', msg(0))?.state).toBe('ended');
  });
  test('Vimeo: timeupdate and ended', () => {
    expect(parseEmbedMessage('https://player.vimeo.com', { event: 'timeupdate', data: { seconds: 8, duration: 60 } }))
      .toEqual({ positionSec: 8, durationSec: 60, state: 'playing' });
    expect(parseEmbedMessage('https://player.vimeo.com', JSON.stringify({ event: 'ended', data: { seconds: 60, duration: 60 } }))?.state).toBe('ended');
  });
  test('messages from any other site, or that are not playback, are ignored', () => {
    const yt = JSON.stringify({ event: 'infoDelivery', info: { currentTime: 300, duration: 300, playerState: 0 } });
    expect(parseEmbedMessage('https://evil.example.com', yt)).toBeNull();
    expect(parseEmbedMessage('https://player.vimeo.com', { event: 'ready' })).toBeNull();
    expect(parseEmbedMessage('https://www.youtube-nocookie.com', 'not json')).toBeNull();
  });
});
