import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    } } };
  }
}

let scriptPromise: Promise<void> | null = null;
const loadScript = () => scriptPromise ??= new Promise<void>((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => resolve();
  s.onerror = () => { scriptPromise = null; reject(new Error('Google sign-in could not load')); };
  document.head.appendChild(s);
});

/** "Sign in with Google" (optional; shown only when the server has a GOOGLE_CLIENT_ID). */
export function GoogleButton({ clientId, onCredential, text = 'signin_with' }: { clientId: string; onCredential: (c: string) => void; text?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;
  useEffect(() => {
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !el.current || !window.google) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => cb.current(r.credential) });
      window.google.accounts.id.renderButton(el.current, { theme: 'outline', size: 'large', text, shape: 'rectangular', width: 320 });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [clientId, text]);
  return <div ref={el} className="google-btn" />;
}
