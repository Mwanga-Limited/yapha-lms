import { useState, type FormEvent } from 'react';
import { platformApi, type User } from '../api';
import { Alert, Button, Field, useAction, useDocumentTitle } from '../ui';
import { usePlatformAuth } from './PlatformApp';
import { passwordOk } from '../password';
import { PasswordInput } from '../components/PasswordInput';

/** The super admin's own password and authenticator app. */
export function PlatformAccount() {
  useDocumentTitle('Your account');
  const { user, setUser } = usePlatformAuth();
  const [pw, setPw] = useState({ cur: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const pwAction = useAction();
  const totp = useAction();

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    if (!passwordOk(pw.next)) { setErr('Your new password doesn’t meet all the requirements yet.'); return; }
    if (pw.next !== pw.again) { setErr('The new passwords do not match'); return; }
    setErr('');
    void pwAction.run(async () => { await platformApi('changePassword', { currentPassword: pw.cur, newPassword: pw.next }); setPw({ cur: '', next: '', again: '' }); }, 'Password changed');
  };

  return (
    <>
      <div className="page-head"><h1>Your account</h1><p className="muted">{user!.email} · platform super admin</p></div>
      <div className="two-col">
        <form className="panel" onSubmit={changePassword}>
          <h2>Change password</h2>
          {err && <Alert tone="error">{err}</Alert>}
          <Field label="Current password" type="password" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} required />
          <PasswordInput label="New password" value={pw.next} onChange={(v) => setPw({ ...pw, next: v })} confirm={pw.again} onConfirmChange={(v) => setPw({ ...pw, again: v })} />
          <Button type="submit" busy={pwAction.busy}>Change password</Button>
        </form>
        <div className="panel">
          <h2>Two-step sign-in</h2>
          <p className="muted">Always required. Without an authenticator app, a code is emailed at each sign-in.</p>
          {user!.totpEnabled ? <Alert tone="ok">Authenticator app is on.</Alert> : setup ? (
            <div className="totp">
              <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} />
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void totp.run(async () => { const r = await platformApi<{ user: User }>('totpEnable', { code }); setUser(r.user); setSetup(null); }, 'Authenticator app turned on'); }}>
                <p>Scan this, or enter the key <code className="secret">{setup.secret}</code></p>
                <Field label="6-digit code from the app" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required pattern="\d{6}" />
                <Button type="submit" busy={totp.busy}>Turn on</Button>
              </form>
            </div>
          ) : <Button variant="secondary" busy={totp.busy} onClick={() => totp.run(async () => setSetup(await platformApi('totpSetup')))}>Set up an authenticator app</Button>}
        </div>
      </div>
    </>
  );
}
