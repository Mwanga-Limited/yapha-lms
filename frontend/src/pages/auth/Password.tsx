import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api';
import { Alert, Button, Field, useDocumentTitle } from '../../ui';

export function ForgotPassword() {
  useDocumentTitle('Reset password');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('auth', 'requestPasswordReset', { email }); setSent(true); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <div className="auth-card">
      <h1>Reset your password</h1>
      {sent ? (
        <Alert tone="ok" title="Check your email">If an account exists for {email}, we sent a link to reset the password. It expires in 60 minutes.</Alert>
      ) : (
        <form onSubmit={submit}>
          <p className="muted">Enter your email and we'll send you a reset link.</p>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Button type="submit" busy={busy} className="btn-block">Send reset link</Button>
        </form>
      )}
      <p className="auth-foot"><Link to="/login">Back to sign in</Link></p>
    </div>
  );
}

export function ResetPassword() {
  useDocumentTitle('Choose a new password');
  const [params] = useSearchParams();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) { setError('The passwords do not match'); return; }
    setBusy(true); setError('');
    try { await api('auth', 'resetPassword', { token: params.get('token') || '', password: pw }); setDone(true); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <div className="auth-card">
      <h1>Choose a new password</h1>
      {done ? (
        <Alert tone="ok" title="Password changed">You have been signed out everywhere. <Link to="/login">Sign in with your new password</Link>.</Alert>
      ) : (
        <form onSubmit={submit}>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoComplete="new-password" hint="At least 8 characters, with letters and numbers." />
          <Field label="Repeat new password" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password" />
          <Button type="submit" busy={busy} className="btn-block">Save new password</Button>
        </form>
      )}
    </div>
  );
}
