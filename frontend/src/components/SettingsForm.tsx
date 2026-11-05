import { useState } from 'react';
import { upload, type TenantSettings } from '../api';
import { Field, useAction } from '../ui';

/**
 * Editor for one organisation's configuration: branding, quiz rules, who can join, sign-in options.
 * Used by the organisation's Admin (Admin › Settings) and by the platform super admin.
 */
export function SettingsForm({ value, onChange, logoPreviewUrl, canUploadLogo }: {
  value: TenantSettings;
  onChange: (s: TenantSettings) => void;
  logoPreviewUrl?: string | null;
  canUploadLogo?: boolean;
}) {
  const set = <K extends keyof TenantSettings>(k: K, patch: Partial<TenantSettings[K]>) => onChange({ ...value, [k]: { ...value[k], ...patch } });
  const [domains, setDomains] = useState(value.access.allowedDomains.join(', '));
  const [logo, setLogo] = useState<string | null>(logoPreviewUrl ?? null);
  const up = useAction();
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || min)));

  return (
    <div className="settings-form">
      <fieldset className="settings-group">
        <legend>Branding</legend>
        <p className="muted small">Shown on every page, in emails and on certificates.</p>
        <Field label="Display name (optional)" hint="Leave empty to use the organisation's name." value={value.branding.displayName} maxLength={80}
          onChange={(e) => set('branding', { displayName: e.target.value })} />
        <div className="field">
          <label htmlFor="accent">Accent colour</label>
          <div className="color-row">
            <input id="accent" type="color" value={value.branding.accentColor} onChange={(e) => set('branding', { accentColor: e.target.value.toUpperCase() })} />
            <code>{value.branding.accentColor}</code>
            <span className="swatch-demo" style={{ background: value.branding.accentColor }}>Progress and highlights</span>
          </div>
        </div>
        <div className="field">
          <span className="label-like">Logo</span>
          <div className="row-gap">
            {logo && value.branding.logoFileId ? <img src={logo} alt="Logo" className="logo-preview" /> : <span className="muted small">No logo</span>}
            {canUploadLogo ? (
              <>
                <label className="btn btn-secondary btn-sm">{up.busy ? 'Uploading…' : 'Upload PNG or JPG'}
                  <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void up.run(async () => { const r = await upload(f, 'logo'); setLogo(r.url); set('branding', { logoFileId: r.id }); });
                  }} />
                </label>
                {value.branding.logoFileId && <button type="button" className="link-btn" onClick={() => set('branding', { logoFileId: null })}>Remove</button>}
              </>
            ) : <span className="muted small">The organisation's Admin uploads the logo.</span>}
          </div>
        </div>
      </fieldset>

      <fieldset className="settings-group">
        <legend>Quiz rules</legend>
        <p className="muted small">Apply to every quiz in this organisation. The default is 70%, 3 attempts and a 24-hour lock.</p>
        <div className="grid-3">
          <Field label="Pass mark (%)" type="number" min={1} max={100} value={value.quiz.passMark} onChange={(e) => set('quiz', { passMark: num(e.target.value, 1, 100) })} />
          <Field label="Attempts before lock" type="number" min={1} max={20} value={value.quiz.maxAttempts} onChange={(e) => set('quiz', { maxAttempts: num(e.target.value, 1, 20) })} />
          <Field label="Lock time (hours)" type="number" min={1} max={720} value={value.quiz.lockHours} onChange={(e) => set('quiz', { lockHours: num(e.target.value, 1, 720) })} />
        </div>
      </fieldset>

      <fieldset className="settings-group">
        <legend>Who can join</legend>
        <label className="check"><input type="radio" name="signup" checked={value.access.signup === 'open'} onChange={() => set('access', { signup: 'open' })} /> Anyone can create an account</label>
        <label className="check"><input type="radio" name="signup" checked={value.access.signup === 'invite'} onChange={() => set('access', { signup: 'invite' })} /> Invite only: Admins invite people from the Users page</label>
        <Field label="Allowed email domains (optional)" placeholder="acme.com, students.acme.com" value={domains}
          hint="Separate with commas. Leave empty to allow any email address."
          onChange={(e) => {
            setDomains(e.target.value);
            set('access', { allowedDomains: e.target.value.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean) });
          }} />
      </fieldset>

      <fieldset className="settings-group">
        <legend>Sign-in options</legend>
        <label className="check"><input type="checkbox" checked={value.auth.google} onChange={(e) => set('auth', { google: e.target.checked })} /> Allow “Sign in with Google”</label>
        <label className="check"><input type="checkbox" checked={value.auth.studentMfa} onChange={(e) => set('auth', { studentMfa: e.target.checked })} /> Require two-step sign-in for students too</label>
        <p className="muted small">Admins and Teachers always use two-step sign-in.</p>
      </fieldset>
    </div>
  );
}
