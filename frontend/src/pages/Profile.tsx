import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, upload, type User } from '../api';
import { useAuth, useTenant } from '../auth';
import { Alert, Button, Field, TextArea, useAction, useDocumentTitle } from '../ui';
import { passwordOk } from '../password';
import { PasswordInput } from '../components/PasswordInput';

function ProfileForm() {
  const { user, setUser } = useAuth();
  const [f, setF] = useState({ name: user!.name, phone: user!.phone ?? '', bio: user!.bio ?? '' });
  const [photo, setPhoto] = useState<{ id: string | null; url: string | null } | null>(null);
  const { busy, run } = useAction();
  const up = useAction();

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ user: User }>('account', 'updateProfile', { ...f, ...(photo ? { photoFileId: photo.id } : {}) });
      setUser(r.user); setPhoto(null);
    }, 'Profile saved');
  };
  const pickPhoto = (file?: File) => file && up.run(async () => { const r = await upload(file, 'photo'); setPhoto({ id: r.id, url: r.url }); });
  const shown = photo ? photo.url : user!.photoUrl;

  return (
    <form onSubmit={save} className="panel">
      <h2>Profile</h2>
      <div className="photo-row">
        {shown ? <img src={shown} alt="Your photo" className="avatar avatar-xl" /> : <span className="avatar avatar-xl avatar-initial">{user!.name.charAt(0)}</span>}
        <div className="row-gap">
          <label className="btn btn-secondary btn-sm">
            {up.busy ? 'Uploading…' : 'Choose photo'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </label>
          {shown && <button type="button" className="link-btn" onClick={() => setPhoto({ id: null, url: null })}>Remove</button>}
          {photo && <span className="muted small">Save to keep this photo</span>}
        </div>
      </div>
      <Field label="Full name" hint={user!.role === 'student' ? 'Printed on your certificates exactly as written here.' : 'Shown to learners on your course pages.'} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <Field label="Email" value={user!.email} disabled hint={user!.emailVerified ? 'Verified' : 'Not verified yet'} />
      <Field label="Phone number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+234 801 234 5678" />
      {user!.role !== 'student' && <TextArea label="Bio" hint="Shown to learners on your course pages." rows={4} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />}
      <Button type="submit" busy={busy}>Save profile</Button>
    </form>
  );
}

function PasswordForm() {
  const { user, refresh } = useAuth();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const { busy, run } = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!passwordOk(pw)) { setErr('Your new password doesn’t meet all the requirements yet.'); return; }
    if (pw !== pw2) { setErr('The new passwords do not match'); return; }
    setErr('');
    void run(async () => { await api('account', 'changePassword', { currentPassword: cur, newPassword: pw }); setCur(''); setPw(''); setPw2(''); await refresh(); },
      'Password changed. Other devices were signed out.');
  };
  return (
    <form onSubmit={save} className="panel">
      <h2>{user!.hasPassword ? 'Change password' : 'Set a password'}</h2>
      {!user!.hasPassword && <p className="muted">You sign in with Google. Add a password to also sign in with your email.</p>}
      {err && <Alert tone="error">{err}</Alert>}
      {user!.hasPassword && <Field label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />}
      <PasswordInput label="New password" value={pw} onChange={setPw} confirm={pw2} onConfirmChange={setPw2} />
      <Button type="submit" busy={busy}>{user!.hasPassword ? 'Change password' : 'Set password'}</Button>
    </form>
  );
}

function TwoFactor() {
  const { user, setUser } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, run } = useAction();
  const privileged = user!.role !== 'student';

  return (
    <div className="panel">
      <h2>Two-step sign-in</h2>
      {privileged
        ? <p className="muted">Required for {user!.role}s. Without an authenticator app, we email you a code each time you sign in.</p>
        : <p className="muted">Optional for learners. Add an authenticator app for extra protection.</p>}
      {user!.totpEnabled ? (
        <>
          <Alert tone="ok">Authenticator app is on.</Alert>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ user: User }>('account', 'totpDisable', { code }); setUser(r.user); setCode(''); }, 'Authenticator app removed'); }}>
            <Field label="Code from your app, to turn it off" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required pattern="\d{6}" />
            <Button variant="secondary" type="submit" busy={busy}>Turn off</Button>
          </form>
        </>
      ) : setup ? (
        <div className="totp">
          <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} />
          <div>
            <p>Scan this with Google Authenticator, Microsoft Authenticator or a similar app. Or enter this key: <code className="secret">{setup.secret}</code></p>
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ user: User }>('account', 'totpEnable', { code }); setUser(r.user); setSetup(null); setCode(''); }, 'Authenticator app turned on'); }}>
              <Field label="6-digit code from the app" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required pattern="\d{6}" />
              <Button type="submit" busy={busy}>Turn on</Button>
            </form>
          </div>
        </div>
      ) : (
        <Button variant="secondary" busy={busy} onClick={() => run(async () => setSetup(await api('account', 'totpSetup')))}>Set up an authenticator app</Button>
      )}
    </div>
  );
}

export function Profile() {
  useDocumentTitle('Profile');
  const { user } = useAuth();
  const tenant = useTenant();
  return (
    <>
      <div className="page-head"><h1>Your account</h1><p className="muted">Signed in as {user!.email} · {user!.role}{user!.isRoot ? ' (first admin)' : ''} · Member ID <code>{user!.memberCode}</code></p>{user!.role === 'student' && <p className="small">Want to teach at {tenant.name}? <Link to="/teach">Apply to become a teacher</Link></p>}</div>
      <div className="two-col">
        <ProfileForm />
        <div className="stack">
          <PasswordForm />
          <TwoFactor />
        </div>
      </div>
    </>
  );
}
