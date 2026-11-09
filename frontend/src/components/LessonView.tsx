import { useEffect, useRef } from 'react';
import type { LessonPayload } from '../api';
import { embedUrl, listenMessages, parseEmbedMessage, shouldReport } from '../watch';

/**
 * Renders a video, text or downloadable-file lesson.
 * For videos, onPosition(positionSec, durationSec) is called while it plays (every few seconds), and on play,
 * pause and end. The server works out how much has really been watched and completes the lesson itself.
 */
export function LessonView({ lesson, startAt = 0, onPosition }: {
  lesson: LessonPayload; startAt?: number;
  /** leaving: the learner is leaving the lesson or the page, so the report must get through even if the page closes */
  onPosition?: (sec: number, durationSec?: number, leaving?: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const lastSaved = useRef<number | null>(null);
  const latest = useRef<{ sec: number; duration?: number } | null>(null);   // where playback is now, reported or not
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  // Nothing watched is lost: when the learner moves to another lesson, switches tab or closes the page,
  // the last few seconds since the previous report are sent too.
  useEffect(() => {
    lastSaved.current = null;
    latest.current = null;
    const report = onPosition;   // this lesson's reporter, even after the player has moved on to the next lesson
    const flush = () => {
      const l = latest.current;
      if (!report || !l || l.sec === lastSaved.current) return;
      lastSaved.current = l.sec;
      report(l.sec, l.duration, true);
    };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [lesson.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = lesson.type === 'video' ? lesson.fileUrl || lesson.videoUrl : null;
  const embed = src && !lesson.fileUrl ? embedUrl(src, startAt, window.location.origin) : null;

  const report = (sec: number, duration: number | undefined, force = false) => {
    const d = duration && Number.isFinite(duration) ? duration : undefined;
    latest.current = { sec, duration: d };
    if (!onPositionRef.current || !shouldReport(lastSaved.current, sec, force)) return;
    lastSaved.current = sec;
    onPositionRef.current(sec, d);
  };
  const fromVideo = (force = false, atEnd = false) => {
    const v = video.current;
    if (!v) return;
    report(atEnd ? v.duration : v.currentTime, v.duration, force);
  };

  // Embedded YouTube / Vimeo players report playback through window messages.
  useEffect(() => {
    if (!embed) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const ev = parseEmbedMessage(e.origin, e.data);
      if (!ev || ev.positionSec === null) return;
      const atEnd = ev.state === 'ended' && ev.durationSec ? ev.durationSec : ev.positionSec;
      report(atEnd, ev.durationSec ?? undefined, ev.state !== 'playing');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embed]); // eslint-disable-line react-hooks/exhaustive-deps
  const startListening = () => {
    const w = frame.current?.contentWindow;
    if (w && embed) for (const m of listenMessages(embed)) w.postMessage(m, '*');
  };

  return (
    <article className="lesson">
      {lesson.type === 'video' && src && (embed ? (
        <div className="video-frame">
          <iframe ref={frame} src={embed} title={lesson.title} onLoad={startListening}
            allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      ) : (
        <div className="video-frame">
          <video
            ref={video} src={src} controls playsInline preload="metadata"
            onLoadedMetadata={() => { if (video.current && startAt > 1 && startAt < video.current.duration - 2) video.current.currentTime = startAt; }}
            onPlay={() => fromVideo(true)}
            onTimeUpdate={() => fromVideo()}
            onPause={() => { if (!video.current?.ended) fromVideo(true); }}
            onEnded={() => fromVideo(true, true)}
          />
        </div>
      ))}
      {lesson.type === 'video' && embed && startAt > 5 && <p className="muted small">Starting from where you stopped.</p>}

      {lesson.type === 'file' && lesson.fileUrl && (
        <div className="file-card">
          <div className="file-icon" aria-hidden>{(lesson.fileName?.split('.').pop() || 'file').slice(0, 4).toUpperCase()}</div>
          <div>
            <strong>{lesson.fileName || 'Lesson file'}</strong>
            <div className="row-gap">
              <a className="btn btn-primary btn-sm" href={`${lesson.fileUrl}&download`} download>Download</a>
              <a className="btn btn-secondary btn-sm" href={lesson.fileUrl} target="_blank" rel="noreferrer">Open in a new tab</a>
            </div>
          </div>
        </div>
      )}

      {lesson.body?.trim() && <div className="prose">{lesson.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>}
    </article>
  );
}
