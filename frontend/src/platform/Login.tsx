import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { errorMessage, platformApi, type User } from '../api';
import { Alert, Button, Field, useDocumentTitle } from '../ui';
import { usePlatformAuth } from './PlatformApp';

type Mfa = { token: string; method: 'totp' | 'email'; emailHint: string | null };

/** Super admin sign-in: always two steps. */
export function PlatformLogin() {
  useDocumentTitle('Sign in');
  const { user, setUser } = usePlatformAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;

  const go = async (fn: () => Promise<{ user?: User; mfa?: Mfa }>) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      if (r.mfa) { setMfa(r.mfa); setCode(''); }
      if (r.user) { setUser(r.user); nav('/', { replace: true }); }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="auth-card">
      <h1>Platform console</h1>
      {!mfa ? (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void go(() => platformApi('login', { email, password })); }}>
          <p className="muted">For platform super admins only. Organisation members sign in on their organisation's site.</p>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" busy={busy} className="btn-block">Continue</Button>
        </form>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void go(() => platformApi('verifyMfa', { token: mfa.token, code })); }}>
          <p className="muted">{mfa.method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : `Enter the 6-digit code we emailed to ${mfa.emailHint}.`}</p>
          {error && <Alert tone="error">{error}</Alert>}
          {note && <Alert tone="ok">{note}</Alert>}
          <Field label="Sign-in code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
            autoComplete="one-time-code" autoFocus required pattern="\d{6}" className="code-input" />
          <Button type="submit" busy={busy} className="btn-block">Verify and sign in</Button>
          <p className="auth-foot">
            <button type="button" className="link-btn" onClick={async () => {
              try { const r = await platformApi<{ emailHint: string }>('sendMfaEmail', { token: mfa.token }); setMfa({ ...mfa, method: 'email', emailHint: r.emailHint }); setNote(`We sent a new code to ${r.emailHint}.`); }
              catch (e) { setError(errorMessage(e)); }
            }}>{mfa.method === 'totp' ? 'Email me a code instead' : 'Send a new code'}</button>
            {' · '}<button type="button" className="link-btn" onClick={() => { setMfa(null); setPassword(''); setNote(''); }}>Start over</button>
          </p>
        </form>
      )}
    </div>
  );
}
