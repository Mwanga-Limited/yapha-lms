import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage, type User } from '../../api';
import { homeFor, useAuth } from '../../auth';
import { GoogleButton } from '../../components/GoogleButton';
import { Alert, Button, Field, useDocumentTitle } from '../../ui';

type Mfa = { token: string; method: 'totp' | 'email'; emailHint: string | null };
type LoginResult = { user?: User; mfa?: Mfa };

export function Login() {
  useDocumentTitle('Sign in');
  const { setUser, googleClientId } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const done = (r: LoginResult) => {
    if (r.mfa) { setMfa(r.mfa); setCode(''); setError(''); return; }
    if (r.user) { setUser(r.user); nav(from || homeFor(r.user.role), { replace: true }); }
  };
  const attempt = async (fn: () => Promise<LoginResult>) => {
    setBusy(true); setError('');
    try { done(await fn()); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void attempt(() => api('auth', 'login', { email, password })); };
  const submitCode = (e: FormEvent) => { e.preventDefault(); void attempt(() => api('auth', 'verifyMfa', { token: mfa!.token, code })); };
  const emailCode = async () => {
    try {
      const r = await api<{ emailHint: string }>('auth', 'sendMfaEmail', { token: mfa!.token });
      setMfa({ ...mfa!, method: 'email', emailHint: r.emailHint });
      setNote(`We sent a new code to ${r.emailHint}.`);
    } catch (e) { setError(errorMessage(e)); }
  };

  if (mfa) {
    return (
      <div className="auth-card">
        <h1>Two-step sign-in</h1>
        <p className="muted">
          {mfa.method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : `Enter the 6-digit code we emailed to ${mfa.emailHint}.`}
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        {note && <Alert tone="ok">{note}</Alert>}
        <form onSubmit={submitCode}>
          <Field label="Sign-in code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" autoFocus required pattern="\d{6}" className="code-input" />
          <Button type="submit" busy={busy} className="btn-block">Verify and sign in</Button>
        </form>
        <p className="auth-foot">
          {mfa.method === 'totp' ? <button className="link-btn" onClick={emailCode}>Email me a code instead</button>
            : <button className="link-btn" onClick={emailCode}>Send a new code</button>}
          {' · '}<button className="link-btn" onClick={() => { setMfa(null); setPassword(''); setNote(''); }}>Start over</button>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Sign in</h1>
      <p className="muted">Pick up where you left off.</p>
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={submit}>
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="row-between"><span /><Link to="/forgot-password">Forgot your password?</Link></div>
        <Button type="submit" busy={busy} className="btn-block">Sign in</Button>
      </form>
      {googleClientId && (
        <>
          <div className="or"><span>or</span></div>
          <GoogleButton clientId={googleClientId} onCredential={(credential) => attempt(() => api('auth', 'google', { credential }))} />
        </>
      )}
      <p className="auth-foot">New here? <Link to="/register">Create an account</Link></p>
    </div>
  );
}
