import { useState } from 'react';
import { api } from '../../api';
import { Button, Empty, Loading, ReasonModal, StatusBadge, Tabs, fmtDate, useAction, useDocumentTitle, useLoad, useToast } from '../../ui';
import { AdminNav } from './Dashboard';

interface App { id: string; name: string; email: string; role: string; email_verified_at: string | null; bio: string; expertise: string; credential_url: string | null; status: string; decision_reason: string | null; reviewer_name: string | null; reviewed_at: string | null; created_at: string }
type Filter = 'pending' | 'approved' | 'declined' | 'all';

export function AdminApplications() {
  useDocumentTitle('Teacher applications');
  const [status, setStatus] = useState<Filter>('pending');
  const { data, loading, reload } = useLoad(() => api<{ applications: App[] }>('admin', 'applications', { status }), [status]);
  const [declining, setDeclining] = useState<App | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Teacher applications</h1><p className="muted">Approving makes the person a Teacher. They must sign in again with two-step verification.</p></div>
      <Tabs<Filter> value={status} onChange={setStatus} tabs={[{ id: 'pending', label: 'Waiting' }, { id: 'approved', label: 'Approved' }, { id: 'declined', label: 'Declined' }, { id: 'all', label: 'All' }]} />
      {loading && !data && <Loading />}
      {data && data.applications.length === 0 && <Empty title={status === 'pending' ? 'No applications are waiting' : 'No applications here'} />}
      <ul className="app-list">
        {data?.applications.map((a) => (
          <li key={a.id} className="panel">
            <div className="row-between">
              <div><strong>{a.name}</strong> <span className="muted">{a.email}</span>{!a.email_verified_at && <span className="badge badge-draft">email not verified</span>}</div>
              <StatusBadge status={a.status} />
            </div>
            <p><span className="muted small">Expertise</span><br />{a.expertise}</p>
            <p className="pre">{a.bio}</p>
            {a.credential_url && <p><a href={a.credential_url} target="_blank" rel="noreferrer noopener">Credential link</a> <span className="muted small">({new URL(a.credential_url).hostname})</span></p>}
            <p className="muted small">Applied {fmtDate(a.created_at)}{a.reviewed_at && ` · decided ${fmtDate(a.reviewed_at)} by ${a.reviewer_name}`}</p>
            {a.decision_reason && <p className="small">Reason: {a.decision_reason}</p>}
            {a.status === 'pending' && (
              <div className="row-gap">
                <Button busy={busy} onClick={() => run(async () => { await api('admin', 'decideApplication', { id: a.id, decision: 'approve' }); await reload(); }, `${a.name} is now a Teacher`)}>Approve</Button>
                <Button variant="secondary" onClick={() => setDeclining(a)}>Decline</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ReasonModal open={!!declining} onClose={() => setDeclining(null)} title={`Decline ${declining?.name ?? ''}`} label="Reason for the applicant" confirmLabel="Decline application"
        onConfirm={async (reason) => {
          try { await api('admin', 'decideApplication', { id: declining!.id, decision: 'decline', reason }); toast('Application declined'); setDeclining(null); await reload(); }
          catch (e) { toast((e as Error).message, 'error'); }
        }} />
    </>
  );
}
