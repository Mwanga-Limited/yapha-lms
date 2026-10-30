import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, type User } from '../../api';
import { useAuth, useTenant } from '../../auth';
import { GoogleOption } from '../../components/GoogleButton';
import { PasswordInput } from '../../components/PasswordInput';
import { passwordOk } from '../../password';
import { Alert, Button, Field, TextArea, useDocumentTitle } from '../../ui';

export function Register() {
  useDocumentTitle('Create account');
  const { setUser, googleClientId } = useAuth();
  const tenant = useTenant();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', bio: '', expertise: '', credentialUrl: '' });
  const [confirm, setConfirm] = useState('');
  const [joinAs, setJoinAs] = useState<'student' | 'teacher'>('student');
  const [withEmail, setWithEmail] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passwordOk(f.password)) { setError('Your password doesn’t meet all the requirements yet.'); return; }
    if (f.password !== confirm) { setError('The two passwords don’t match.'); return; }
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

  const withGoogle = async (credential: string) => {
    setError('');
    try {
      const r = await api<{ user?: User; mfa?: unknown }>('auth', 'google', { credential });
      if (r.user) {
        setUser(r.user);
        // People who chose "Teach" finish their instructor application on the Teach page.
        nav(joinAs === 'teacher' ? '/teach' : '/dashboard', { replace: true });
      } else {
        nav('/login');
      }
    } catch (err) { setError(errorMessage(err)); }
  };

  if (tenant.access.signup === 'invite') {
    return (
      <div className="auth-card">
        <h1>Joining {tenant.name}</h1>
        <p>{tenant.name} is invite-only. An administrator sends you an email invitation with a link to set your password.</p>
        <p className="muted">Already invited? Open the link in your invitation email.</p>
        <p className="auth-foot">Already have an account? <Link to="/login">Sign in</Link></p>
      </div>
    );
  }
  const domainHint = tenant.access.allowedDomains.length ? `Use your ${tenant.access.allowedDomains.map((d) => '@' + d).join(' or ')} email address.` : undefined;

  return (
    <div className="auth-card auth-card-wide">
      <h1>Join {tenant.name}</h1>
      {error && <Alert tone="error">{error}</Alert>}

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

      <div className="signup-choices">
        <GoogleOption allowed={tenant.auth.google} clientId={googleClientId} label="Sign up with Google" onCredential={withGoogle} />
        {!withEmail && <Button type="button" variant="secondary" className="btn-block" onClick={() => setWithEmail(true)}>Sign up with email</Button>}
      </div>
      {joinAs === 'teacher' && tenant.auth.google && !withEmail && (
        <p className="muted small">If you sign up with Google, you’ll fill in your teaching profile on the next page.</p>
      )}

      {withEmail && (
        <form onSubmit={submit}>
          <div className="or"><span>Sign up with email</span></div>
          <Field label="Full name" hint={joinAs === 'student' ? 'This name is printed on your certificates.' : 'Shown to learners on your course pages.'}
            value={f.name} onChange={set('name')} required autoComplete="name" autoFocus />
          <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="email" hint={domainHint} />
          <PasswordInput value={f.password} onChange={(v) => setF({ ...f, password: v })} confirm={confirm} onConfirmChange={setConfirm} />
          {joinAs === 'teacher' && (
            <div className="subform">
              <p className="muted">An admin reviews every instructor application. You can learn on the platform while you wait.</p>
              <Field label="Area of expertise" placeholder="e.g. Data analysis, Yoruba language, Accounting" value={f.expertise} onChange={set('expertise')} required />
              <TextArea label="Short profile" rows={4} value={f.bio} onChange={set('bio')} required minLength={20}
                hint="Who you are and what you have taught or practised (at least 20 characters)." />
              <Field label="ID or credential link (optional)" type="url" placeholder="https://" value={f.credentialUrl} onChange={set('credentialUrl')} />
            </div>
          )}
          <Button type="submit" busy={busy} className="btn-block" disabled={!passwordOk(f.password) || f.password !== confirm}>
            {joinAs === 'teacher' ? 'Create account and apply' : 'Create account'}
          </Button>
        </form>
      )}
      <p className="auth-foot">Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  );
}
