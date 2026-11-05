import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { platformApi } from '../api';
import { Button, Empty, Field, Loading, Modal, StatusBadge, fmtDate, useAction, useDocumentTitle, useLoad } from '../ui';
import type { TenantRow } from './types';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function CreateOrganisation({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const { busy, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await platformApi<{ tenant: TenantRow }>('createTenant', f);
      onClose();
      nav(`/organisations/${r.tenant.id}`);
    }, `Organisation created. ${f.adminEmail} has been invited as its first Admin.`);
  };
  return (
    <form onSubmit={submit}>
      <Field label="Organisation name" value={f.name} required maxLength={120} autoFocus
        onChange={(e) => setF({ ...f, name: e.target.value, slug: slugEdited ? f.slug : slugify(e.target.value) })} />
      <Field label="Web address" value={f.slug} required pattern="[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?"
        hint={<>Its site will be <strong>{window.location.host}/t/{f.slug || 'name'}</strong>. Lowercase letters, numbers and dashes. It can't be changed later.</>}
        onChange={(e) => { setSlugEdited(true); setF({ ...f, slug: e.target.value.toLowerCase() }); }} />
      <fieldset className="settings-group">
        <legend>First Admin</legend>
        <p className="muted small">They receive an email invitation to set their password. They can't be demoted or deactivated (AD-04).</p>
        <Field label="Full name" value={f.adminName} required onChange={(e) => setF({ ...f, adminName: e.target.value })} />
        <Field label="Email" type="email" value={f.adminEmail} required onChange={(e) => setF({ ...f, adminEmail: e.target.value })} />
      </fieldset>
      <p className="muted small">The organisation starts with the default rules (70% pass mark, 3 attempts, 24-hour lock, open sign-up). You or its Admin can change them.</p>
      <div className="row-end">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" busy={busy}>Create organisation</Button>
      </div>
    </form>
  );
}

export function Organisations() {
  useDocumentTitle('Organisations');
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [f, setFilter] = useState({ q: '', status: '' });
  const { data, loading } = useLoad(() => platformApi<{ tenants: TenantRow[] }>('tenants', f), [f]);
  const creating = params.get('new') === '1';

  return (
    <>
      <div className="page-head row-between">
        <div><h1>Organisations</h1><p className="muted">Each one has its own members, courses, rules and audit log.</p></div>
        <Button onClick={() => setParams({ new: '1' })}>Add an organisation</Button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setFilter({ ...f, q }); }}>
        <input type="search" aria-label="Search organisations" placeholder="Name or web address" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={f.status} onChange={(e) => setFilter({ ...f, status: e.target.value })}>
          <option value="">Active and suspended</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select>
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.tenants.length === 0 && <Empty title="No organisations match" />}
      {data && data.tenants.length > 0 && (
        <ul className="org-list">
          {data.tenants.map((t) => (
            <li key={t.id}>
              <Link to={`/organisations/${t.id}`} className="org-item">
                <div>
                  <strong>{t.displayName}</strong>
                  <span className="muted small">/t/{t.slug} · created {fmtDate(t.createdAt)}</span>
                </div>
                <div className="org-item-stats">
                  <span>{t.counts?.members ?? 0} members</span>
                  <span>{t.counts?.publishedCourses ?? 0} courses</span>
                  <StatusBadge status={t.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Modal title="Add an organisation" open={creating} onClose={() => setParams({})}>
        <CreateOrganisation onClose={() => setParams({})} />
      </Modal>
    </>
  );
}
