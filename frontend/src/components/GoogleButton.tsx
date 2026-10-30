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

const G_LOGO = (
  <svg viewBox="0 0 48 48" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.5 5.8c4.4-4 6.8-10 6.8-17.2z" />
    <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
  </svg>
);

/**
 * Google option for sign-in / sign-up.
 * - Organisation allows Google and the server is connected to Google: the real Google button.
 * - Organisation allows Google but the server isn't connected yet: a disabled button that says so.
 * - Organisation turned Google off: nothing.
 */
export function GoogleOption({ allowed, clientId, label, onCredential }: {
  allowed: boolean; clientId: string | null; label: string; onCredential: (c: string) => void;
}) {
  if (!allowed) return null;
  if (clientId) return <GoogleButton clientId={clientId} text={label.toLowerCase().includes('up') ? 'signup_with' : 'signin_with'} onCredential={onCredential} />;
  return (
    <div>
      <button type="button" className="btn btn-google btn-block" disabled>{G_LOGO}{label}</button>
      <p className="google-unavailable">Google sign-in will be available once the platform administrator connects Google.</p>
    </div>
  );
}
