import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, type User } from '../../api';
import { useAuth } from '../../auth';
import { GoogleButton } from '../../components/GoogleButton';
import { Alert, Button, Field, TextArea, useDocumentTitle } from '../../ui';

export function Register() {
  useDocumentTitle('Create account');
  const { setUser, googleClientId } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', bio: '', expertise: '', credentialUrl: '' });
  const [joinAs, setJoinAs] = useState<'student' | 'teacher'>('student');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ user: User }>('auth', 'register', {
        name: f.name, email: f.email, password: f.password, joinAs,
        application: joinAs === 'teacher' ? { bio: f.bio, expertise: f.expertise, credentialUrl: f.credentialUrl } : undefined,
      });
      setUser(r.user);
      nav(joinAs === 'teacher' ? '/teach' : '/dashboard', { replace: true });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <div className="auth-card auth-card-wide">
      <h1>Create your account</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={submit}>
        <fieldset className="choice">
          <legend>I want to</legend>
          <label className={joinAs === 'student' ? 'choice-opt on' : 'choice-opt'}>
            <input type="radio" name="joinAs" checked={joinAs === 'student'} onChange={() => setJoinAs('student')} />
            <span><strong>Learn</strong><small>Take courses and earn certificates</small></span>
          </label>
          <label className={joinAs === 'teacher' ? 'choice-opt on' : 'choice-opt'}>
            <input type="radio" name="joinAs" checked={joinAs === 'teacher'} onChange={() => setJoinAs('teacher')} />
            <span><strong>Teach</strong><small>Apply to publish your own courses</small></span>
          </label>
        </fieldset>
        <Field label="Full name" hint="This name is printed on your certificates." value={f.name} onChange={set('name')} required autoComplete="name" />
        <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
        <Field label="Password" type="password" value={f.password} onChange={set('password')} required minLength={8} autoComplete="new-password"
          hint="At least 8 characters, with letters and numbers." />
        {joinAs === 'teacher' && (
          <div className="subform">
            <p className="muted">An admin reviews every instructor application. You can learn on the platform while you wait.</p>
            <Field label="Area of expertise" placeholder="e.g. Data analysis, Yoruba language, Accounting" value={f.expertise} onChange={set('expertise')} required />
            <TextArea label="Short profile" rows={4} value={f.bio} onChange={set('bio')} required minLength={20}
              hint="Who you are and what you have taught or practised (at least 20 characters)." />
            <Field label="ID or credential link (optional)" type="url" placeholder="https://" value={f.credentialUrl} onChange={set('credentialUrl')} />
          </div>
        )}
        <Button type="submit" busy={busy} className="btn-block">{joinAs === 'teacher' ? 'Create account and apply' : 'Create account'}</Button>
      </form>
      {googleClientId && joinAs === 'student' && (
        <>
          <div className="or"><span>or</span></div>
          <GoogleButton clientId={googleClientId} text="signup_with" onCredential={async (credential) => {
            try {
              const r = await api<{ user?: User; mfa?: unknown }>('auth', 'google', { credential });
              if (r.user) { setUser(r.user); nav('/dashboard'); } else nav('/login');
            } catch (err) { setError(errorMessage(err)); }
          }} />
        </>
      )}
      <p className="auth-foot">Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  );
}
