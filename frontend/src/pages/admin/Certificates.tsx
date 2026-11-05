import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Empty, Loading, Pager, ReasonModal, fmtDate, useDocumentTitle, useLoad, useToast } from '../../ui';
import { AdminNav } from './Dashboard';

interface Cert { id: string; code: string; recipient_name: string; email: string; course_title: string; issued_at: string; revoked_at: string | null; revoke_reason: string | null }

export function AdminCertificates() {
  useDocumentTitle('Certificates');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ q: '', page: 1 });
  const { data, loading, reload } = useLoad(() => api<{ certificates: Cert[]; total: number; pageSize: number }>('admin', 'certificates', f), [f]);
  const [revoking, setRevoking] = useState<Cert | null>(null);
  const toast = useToast();
  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Certificates</h1></div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setF({ q, page: 1 }); }}>
        <input type="search" aria-label="Search certificates" placeholder="Code, learner, email or course" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.certificates.length === 0 && <Empty title="No certificates found" />}
      {data && data.certificates.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Code</th><th>Learner</th><th>Course</th><th>Issued</th><th>Status</th></tr></thead>
            <tbody>
              {data.certificates.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/verify/${c.code}`}><code>{c.code}</code></Link></td>
                  <td>{c.recipient_name}<div className="muted small">{c.email}</div></td>
                  <td>{c.course_title}</td>
                  <td>{fmtDate(c.issued_at)}</td>
                  <td>{c.revoked_at
                    ? <span className="warn-text" title={c.revoke_reason ?? ''}>Revoked {fmtDate(c.revoked_at)}<div className="small muted">{c.revoke_reason}</div></span>
                    : <button className="link-btn danger-text" onClick={() => setRevoking(c)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={f.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      <ReasonModal open={!!revoking} onClose={() => setRevoking(null)} title={`Revoke ${revoking?.code ?? ''}`} label="Reason (shown on the public verification page)" confirmLabel="Revoke certificate"
        onConfirm={async (reason) => {
          try { await api('admin', 'revokeCertificate', { id: revoking!.id, reason }); toast('Certificate revoked'); setRevoking(null); await reload(); }
          catch (e) { toast((e as Error).message, 'error'); }
        }} />
    </>
  );
}
