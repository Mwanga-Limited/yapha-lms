// Watching videos: how the player turns playback into progress reports for the server.
// The server decides what counts as watched (it ignores skipping ahead); these helpers only decide when to report.

/** How often (in seconds of playback) the player reports its position while a video plays. */
export const REPORT_EVERY_SEC = 5;

export interface WatchState { watchedSec: number; durationSec: number; percent: number; requiredPercent: number }

/** Report while playing every REPORT_EVERY_SEC seconds of movement, and always on play, pause and end (force). */
export function shouldReport(lastReportedSec: number | null, currentSec: number, force = false): boolean {
  if (force || lastReportedSec === null) return true;
  return Math.abs(currentSec - lastReportedSec) >= REPORT_EVERY_SEC;
}

/** "62% watched · watch at least 90% to complete" */
export function watchLabel(w: WatchState | null | undefined): string {
  if (!w || w.durationSec <= 0) return `Watch the video to complete this lesson`;
  return `${w.percent}% watched`
}

/** YouTube / Vimeo link → embeddable player URL that reports playback (or null if it isn't one). */
export function embedUrl(url: string, start: number, origin = ''): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let yt: string | null = null;
    if (host === 'youtu.be') yt = u.pathname.slice(1);
    if (host.endsWith('youtube.com')) yt = u.searchParams.get('v') || u.pathname.match(/\/(embed|shorts)\/([\w-]+)/)?.[2] || null;
    if (yt) return `https://www.youtube-nocookie.com/embed/${yt}?rel=0&start=${Math.floor(start)}&enablejsapi=1${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`;
    if (host.endsWith('vimeo.com')) {
      const id = u.pathname.match(/(\d+)/)?.[1];
      if (id) return `https://player.vimeo.com/video/${id}?api=1#t=${Math.floor(start)}s`;
    }
  } catch { /* not a URL */ }
  return null;
}

export interface EmbedEvent { positionSec: number | null; durationSec: number | null; state: 'playing' | 'paused' | 'ended' | null }

/** Read a playback message posted by an embedded YouTube or Vimeo player (anything else → null). */
export function parseEmbedMessage(origin: string, data: unknown): EmbedEvent | null {
  let msg: unknown = data;
  if (typeof data === 'string') { try { msg = JSON.parse(data); } catch { return null; } }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  if (/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(origin) && m.event === 'infoDelivery' && m.info && typeof m.info === 'object') {
    const info = m.info as Record<string, unknown>;
    const ps = num(info.playerState);   // 0 ended, 1 playing, 2 paused
    return {
      positionSec: num(info.currentTime), durationSec: num(info.duration),
      state: ps === 0 ? 'ended' : ps === 1 ? 'playing' : ps === 2 ? 'paused' : null,
    };
  }
  if (origin === 'https://player.vimeo.com' && typeof m.event === 'string') {
    const d = (m.data && typeof m.data === 'object' ? m.data : {}) as Record<string, unknown>;
    const state = m.event === 'ended' ? 'ended' : m.event === 'pause' ? 'paused' : m.event === 'play' || m.event === 'timeupdate' ? 'playing' : null;
    if (!state) return null;
    return { positionSec: num(d.seconds), durationSec: num(d.duration), state };
  }
  return null;
}

/** Messages that ask an embedded player to start reporting playback. */
export function listenMessages(src: string): string[] {
  if (src.includes('youtube')) return [JSON.stringify({ event: 'listening', id: 1, channel: 'widget' })];
  if (src.includes('vimeo')) return ['timeupdate', 'pause', 'ended', 'play'].map((value) => JSON.stringify({ method: 'addEventListener', value }));
  return [];
}
