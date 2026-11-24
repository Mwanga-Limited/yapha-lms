import { useState } from 'react';

/** Shown once, right after the authenticator app is turned on (or new codes are made). Never retrievable afterwards. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Recovery codes (each works once)\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'recovery-codes.txt'; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="recovery" role="region" aria-label="Recovery codes">
      <h3>Save your recovery codes</h3>
      <p className="muted">If you lose your phone, each of these codes lets you sign in once. They are shown only now. Keep them somewhere safe, not in your email.</p>
      <ul className="recovery-list">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="row-gap">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download</button>
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
      <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone}>Done</button>
    </div>
  );
}
