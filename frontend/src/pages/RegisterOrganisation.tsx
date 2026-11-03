import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, organisationsApi } from '../api';
import { PasswordInput } from '../components/PasswordInput';
import { passwordOk } from '../password';
import { Alert, Button, Field, useDocumentTitle } from '../ui';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

type Check = { state: 'idle' | 'checking' | 'ok' | 'taken'; reason?: string | null };
interface Registered { organisation: { slug: string; name: string; url: string }; admin: { email: string; memberCode: string } }

/** "/register" — an organisation registers itself. The person filling it in becomes its first Admin. */
export function RegisterOrganisation() {
  useDocumentTitle('Register your organisation');
  const [f, setF] = useState({ organisationName: '', slug: '', name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Registered | null>(null);

  useEffect(() => { organisationsApi<{ signupOpen: boolean }>('info').then((r) => setOpen(r.signupOpen)).catch(() => setOpen(true)); }, []);

  // Check the web address while the person types (after a short pause).
  useEffect(() => {
    if (!f.slug) { setCheck({ state: 'idle' }); return; }
    setCheck({ state: 'checking' });
    const t = setTimeout(() => {
      organisationsApi<{ available: boolean; reason: string | null }>('checkAddress', { slug: f.slug })
        .then((r) => setCheck({ state: r.available ? 'ok' : 'taken', reason: r.reason }))
        .catch(() => setCheck({ state: 'idle' }));
    }, 350);
    return () => clearTimeout(t);
  }, [f.slug]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (check.state === 'taken') { setError(check.reason || 'Choose another web address.'); return; }
    if (!passwordOk(f.password)) { setError('Your password doesn’t meet all the requirements yet.'); return; }
    if (f.password !== confirm) { setError('The two passwords don’t match.'); return; }
    setBusy(true); setError('');
    try {
      setDone(await organisationsApi<Registered>('register', f));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const host = window.location.host;

  if (done) {
    return (
      <main className="landing">
        <div className="landing-card">
          <span className="brand-mark" aria-hidden />
          <h1>{done.organisation.name} is ready</h1>
          <p>Your learning site is <strong>{host}{done.organisation.url}</strong>. Save this address and share it with your teachers and students.</p>
          <p>You are its first Admin. Your member ID is <code>{done.admin.memberCode}</code>.</p>
          <p className="muted small">We sent a link to <strong>{done.admin.email}</strong> to confirm your email. When you sign in, we’ll also send you a sign-in code, because Admins always sign in with two steps.</p>
          <a className="btn btn-primary btn-block" href={`${done.organisation.url}/login`}>Sign in to {done.organisation.name}</a>
        </div>
      </main>
    );
  }

  return (
    <main className="landing">
      <div className="landing-card landing-card-wide">
        <span className="brand-mark" aria-hidden />
        <h1>Register your organisation</h1>
        <p className="muted">Create a learning site for your school, company or academy. You’ll be its first Admin and can invite teachers and students straight away.</p>
        {open === false ? (
          <Alert tone="info">New organisations can’t register right now. Please contact the platform team.</Alert>
        ) : (
          <form onSubmit={submit} className="landing-form">
            <fieldset className="settings-group">
              <legend>Your organisation</legend>
              <Field label="Organisation name" value={f.organisationName} required maxLength={120} autoFocus
                onChange={(e) => setF({ ...f, organisationName: e.target.value, slug: slugEdited ? f.slug : slugify(e.target.value) })} />
              <Field label="Web address" value={f.slug} required maxLength={40} autoCapitalize="none" spellCheck={false}
                pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?"
                hint={<>Your site will be <strong>{host}/{f.slug || 'your-name'}</strong>. Lowercase letters, numbers and dashes. It can’t be changed later.</>}
                error={check.state === 'taken' ? (check.reason ?? 'Not available') : undefined}
                onChange={(e) => { setSlugEdited(true); setF({ ...f, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') }); }} />
              {check.state === 'checking' && <p className="small muted">Checking…</p>}
              {check.state === 'ok' && <p className="small field-ok">✓ {host}/{f.slug} is available</p>}
            </fieldset>
            <fieldset className="settings-group">
              <legend>You (the first Admin)</legend>
              <Field label="Full name" value={f.name} required maxLength={120} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} />
              <Field label="Work email" type="email" value={f.email} required autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} />
              <PasswordInput value={f.password} onChange={(v) => setF({ ...f, password: v })} confirm={confirm} onConfirmChange={setConfirm} />
            </fieldset>
            <p className="muted small">Your organisation starts with the default rules (70% pass mark, 3 quiz attempts, 24-hour lock, open sign-up for students). You can change them any time in Admin › Settings.</p>
            {error && <Alert tone="error">{error}</Alert>}
            <Button type="submit" busy={busy} className="btn-block">Register organisation</Button>
          </form>
        )}
        <p className="small muted landing-foot">Already registered? <a href="/">Find your organisation</a></p>
      </div>
    </main>
  );
}
