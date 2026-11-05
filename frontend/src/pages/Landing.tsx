import { useState, type FormEvent } from 'react';
import { useDocumentTitle } from '../ui';

/** "/" — people arrive here without an organisation in the address. Organisations are never listed publicly. */
export function Landing() {
  useDocumentTitle('Find your organisation');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');

  const go = async (e: FormEvent) => {
    e.preventDefault();
    const s = slug.trim().toLowerCase().replace(/^.*\/t\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(s)) { setError('Use the short name from your organisation’s address, e.g. acme-academy'); return; }
    const r = await fetch(`/api/t/${s}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'me', data: {} }) }).catch(() => null);
    if (!r) { setError('Cannot reach the server. Check your connection and try again.'); return; }
    if (r.status === 404) { setError(`No organisation uses “${s}”. Check the address you were given.`); return; }
    window.location.href = `/t/${s}/`;
  };

  return (
    <main className="landing">
      <div className="landing-card">
        <span className="brand-mark" aria-hidden />
        <h1>Find your organisation</h1>
        <p className="muted">Each school, company or academy has its own learning site. Enter the short name from the address you were given, for example <strong>acme</strong> in {window.location.host}/t/<strong>acme</strong>.</p>
        <form onSubmit={go} className="landing-form">
          <label htmlFor="org" className="sr-only">Organisation</label>
          <div className="slug-input">
            <span aria-hidden>/t/</span>
            <input id="org" value={slug} onChange={(e) => { setSlug(e.target.value); setError(''); }} placeholder="your-organisation" autoFocus autoCapitalize="none" spellCheck={false} />
          </div>
          {error && <p className="field-error">{error}</p>}
          <button className="btn btn-primary btn-block" type="submit">Continue</button>
        </form>
        <p className="small muted landing-foot">Platform administrator? <a href="/platform">Open the platform console</a></p>
      </div>
    </main>
  );
}
