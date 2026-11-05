import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, apiUrl } from '../api';
import { Alert, Button, Loading, fmtDate, useDocumentTitle, useLoad } from '../ui';

interface Cert { code: string; valid: boolean; recipientName: string; courseTitle: string; teacherName: string; issuedAt: string; revokedAt: string | null; revokeReason: string | null }

async function lookup(code: string): Promise<Cert> {
  const res = await fetch(apiUrl(`/certificates/${encodeURIComponent(code)}`));
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error || 'Not found', res.status, body);
  return body.certificate;
}

export function VerifyCertificate() {
  useDocumentTitle('Verify a certificate');
  const { code = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(code);
  const { data, error, loading } = useLoad(() => (code ? lookup(code) : Promise.resolve(null)), [code]);

  return (
    <div className="verify">
      <h1>Verify a certificate</h1>
      <p className="muted">Enter the code printed at the bottom of the certificate.</p>
      <form className="search" onSubmit={(e) => { e.preventDefault(); if (input.trim()) nav(`/verify/${input.trim().toUpperCase()}`); }}>
        <input aria-label="Certificate code" placeholder="EL-XXXX-XXXX-XXXX" value={input} onChange={(e) => setInput(e.target.value)} className="mono-input" />
        <Button type="submit">Check</Button>
      </form>
      {code && loading && <Loading label="Checking" />}
      {code && error ? <Alert tone="error" title="No certificate has this code">Check the code for typing mistakes. Codes look like EL-ABCD-2345-WXYZ.</Alert> : null}
      {data && (
        <div className={`cert-result ${data.valid ? 'valid' : 'revoked'}`}>
          <div className="cert-stamp">{data.valid ? 'Valid certificate' : 'Revoked'}</div>
          <p className="cert-line">This certifies that</p>
          <p className="cert-name">{data.recipientName}</p>
          <p className="cert-line">completed</p>
          <p className="cert-course">{data.courseTitle}</p>
          <dl className="cert-meta">
            <div><dt>Teacher</dt><dd>{data.teacherName}</dd></div>
            <div><dt>Issued</dt><dd>{fmtDate(data.issuedAt)}</dd></div>
            <div><dt>Code</dt><dd><code>{data.code}</code></dd></div>
          </dl>
          {!data.valid && <Alert tone="error" title={`Revoked on ${fmtDate(data.revokedAt)}`}>{data.revokeReason}</Alert>}
          {data.valid && <a className="btn btn-secondary" href={apiUrl(`/certificates/${data.code}?format=pdf`)} target="_blank" rel="noreferrer">View PDF</a>}
        </div>
      )}
    </div>
  );
}
