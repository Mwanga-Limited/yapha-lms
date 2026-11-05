import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { platformApi, type TenantSettings } from '../api';
import { SettingsForm } from '../components/SettingsForm';
import { Alert, Button, ErrorState, Field, Loading, Modal, StatusBadge, fmtDate, fmtDateTime, plural, useAction, useDocumentTitle, useLoad } from '../ui';
import type { TenantDetail } from './types';

export function OrganisationDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => platformApi<TenantDetail>('tenant', { id }), [id]);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [name, setName] = useState('');
  const [addAdmin, setAddAdmin] = useState(false);
  const [admin, setAdmin] = useState({ name: '', email: '' });
  const { busy, run } = useAction();
  useDocumentTitle(data?.tenant.displayName ?? 'Organisation');
  useEffect(() => { if (data) { setDraft(data.settings); setName(data.tenant.name); } }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || !draft) return null;
  const t = data.tenant;
  const c = t.counts!;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings) || name !== t.name;
  const site = `/t/${t.slug}`;

  const setStatus = (status: 'active' | 'suspended') => {
    if (status === 'suspended' && !confirm(`Suspend ${t.displayName}? Its members can't use the site until you reactivate it. Nothing is deleted.`)) return;
    void run(async () => { await platformApi('updateTenant', { id: t.id, status }); await reload(); }, status === 'suspended' ? 'Organisation suspended' : 'Organisation reactivated');
  };

  return (
    <>
      <div className="page-head editor-head">
        <div>
          <Link to="/organisations" className="small">Organisations</Link>
          <h1>{t.displayName}</h1>
          <div className="row-gap"><StatusBadge status={t.status} /><span className="muted small">{window.location.host}{site} · created {fmtDate(t.createdAt)}</span></div>
        </div>
        <div className="row-gap">
          <a className="btn btn-primary" href={`${site}/admin`}>Open its Admin area</a>
          <a className="btn btn-secondary" href={`${site}/`} target="_blank" rel="noreferrer">View its site</a>
          {t.status === 'active'
            ? <Button variant="ghost" busy={busy} onClick={() => setStatus('suspended')}>Suspend</Button>
            : <Button variant="secondary" busy={busy} onClick={() => setStatus('active')}>Reactivate</Button>}
        </div>
      </div>
      {t.status === 'suspended' && <Alert tone="warn" title="Suspended">Members can't sign in or use the site. You can still open its Admin area.</Alert>}

      <div className="org-ids panel">
        <div><span className="muted small">Organisation ID</span><code>{t.id}</code></div>
        <div><span className="muted small">Members</span><span>{c.members} · {plural(c.students, 'student')}, {plural(c.teachers, 'teacher')}, {plural(c.admins, 'admin')}</span></div>
        <div><span className="muted small">Courses</span><span>{c.publishedCourses} published · {c.awaitingReview} in review</span></div>
        <div><span className="muted small">Learning</span><span>{plural(c.enrollments, 'enrolment')} · {plural(c.completions, 'completion')} · {plural(c.certificates, 'certificate')}</span></div>
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="row-between"><h2>Admins</h2><Button small variant="secondary" onClick={() => { setAdmin({ name: '', email: '' }); setAddAdmin(true); }}>Add an Admin</Button></div>
          <ul className="admin-list">
            {data.admins.map((a) => (
              <li key={a.id}>
                <div><strong>{a.name}</strong>{a.isRoot && <span className="badge badge-approved">First admin</span>}<div className="muted small">{a.email} · <code>{a.memberCode}</code></div></div>
                <span className="small">{!a.isActive ? 'Deactivated' : a.activated ? 'Active' : <span className="warn-text">Invitation not accepted yet</span>}</span>
              </li>
            ))}
          </ul>
          <h2 className="mt">Recent activity</h2>
          {data.activity.length === 0 ? <p className="muted">Nothing yet.</p> : (
            <ul className="activity">
              {data.activity.map((e) => (
                <li key={e.id}><code>{e.action}</code> <span className="muted small">{e.actor_email ?? 'system'}{e.actor_role === 'superadmin' ? ' (platform)' : ''} · {fmtDateTime(e.created_at)}</span></li>
              ))}
            </ul>
          )}
          <Link to={`/audit?tenant=${t.id}`} className="small">Full audit log for this organisation</Link>
        </section>

        <section className="panel">
          <h2>Name and rules</h2>
          <Field label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          <SettingsForm value={draft} onChange={setDraft} logoPreviewUrl={data.public.branding.logoUrl} />
          <div className="row-end">
            <Button disabled={!dirty || !name.trim()} busy={busy}
              onClick={() => run(async () => { await platformApi('updateTenant', { id: t.id, name, settings: draft }); await reload(); }, 'Organisation updated')}>Save changes</Button>
          </div>
        </section>
      </div>

      <Modal title={`Add an Admin to ${t.displayName}`} open={addAdmin} onClose={() => setAddAdmin(false)}>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await platformApi('addTenantAdmin', { tenantId: t.id, ...admin }); setAddAdmin(false); await reload(); }, `Invitation sent to ${admin.email}`); }}>
          <p className="muted">They get an email invitation to this organisation only.</p>
          <Field label="Full name" value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} required />
          <Field label="Email" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} required />
          <div className="row-end">
            <Button type="button" variant="ghost" onClick={() => setAddAdmin(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Send invitation</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
