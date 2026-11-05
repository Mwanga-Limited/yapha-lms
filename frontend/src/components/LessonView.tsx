import { useEffect, useRef } from 'react';
import type { LessonPayload } from '../api';

function embedUrl(url: string, start: number): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let yt: string | null = null;
    if (host === 'youtu.be') yt = u.pathname.slice(1);
    if (host.endsWith('youtube.com')) yt = u.searchParams.get('v') || u.pathname.match(/\/(embed|shorts)\/([\w-]+)/)?.[2] || null;
    if (yt) return `https://www.youtube-nocookie.com/embed/${yt}?rel=0&start=${Math.floor(start)}`;
    if (host.endsWith('vimeo.com')) {
      const id = u.pathname.match(/(\d+)/)?.[1];
      if (id) return `https://player.vimeo.com/video/${id}#t=${Math.floor(start)}s`;
    }
  } catch { /* not a URL */ }
  return null;
}

/** Renders a video, text or downloadable-file lesson. onPosition is called while a native video plays. */
export function LessonView({ lesson, startAt = 0, onPosition, onEnded }: {
  lesson: LessonPayload; startAt?: number; onPosition?: (sec: number) => void; onEnded?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const lastSaved = useRef(0);

  useEffect(() => { lastSaved.current = startAt; }, [lesson.id, startAt]);

  const src = lesson.type === 'video' ? lesson.fileUrl || lesson.videoUrl : null;
  const embed = src && !lesson.fileUrl ? embedUrl(src, startAt) : null;

  return (
    <article className="lesson">
      {lesson.type === 'video' && src && (embed ? (
        <div className="video-frame">
          <iframe src={embed} title={lesson.title} allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      ) : (
        <div className="video-frame">
          <video
            ref={video} src={src} controls playsInline preload="metadata"
            onLoadedMetadata={() => { if (video.current && startAt > 1 && startAt < video.current.duration - 2) video.current.currentTime = startAt; }}
            onTimeUpdate={() => {
              const t = video.current?.currentTime ?? 0;
              if (onPosition && Math.abs(t - lastSaved.current) >= 10) { lastSaved.current = t; onPosition(t); }
            }}
            onPause={() => { const t = video.current?.currentTime ?? 0; lastSaved.current = t; onPosition?.(t); }}
            onEnded={onEnded}
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
