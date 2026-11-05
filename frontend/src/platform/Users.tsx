import { useState } from 'react';
import { platformApi } from '../api';
import { Empty, Loading, Pager, fmtDate, useDocumentTitle, useLoad } from '../ui';
import type { TenantRow } from './types';

interface Row {
  id: string; name: string; email: string; role: string; memberCode: string; isRoot: boolean; isActive: boolean; emailVerified: boolean; createdAt: string;
  tenant: { id: string; name: string; slug: string };
}

/** Everyone in every organisation (read-only). Changes are made inside the organisation's Admin area. */
export function PlatformUsers() {
  useDocumentTitle('People');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ q: '', tenantId: '', role: '', page: 1 });
  const tenants = useLoad(() => platformApi<{ tenants: TenantRow[] }>('tenants'), []);
  const { data, loading } = useLoad(() => platformApi<{ users: Row[]; total: number; pageSize: number }>('users', f), [f]);
  return (
    <>
      <div className="page-head"><h1>People</h1><p className="muted">Everyone in every organisation. To change someone's role or deactivate them, open their organisation's Admin area.</p></div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q, page: 1 }); }}>
        <input type="search" aria-label="Search people" placeholder="Name, email or member ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Organisation" value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value, page: 1 })}>
          <option value="">All organisations</option>
          {tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
        </select>
        <select aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })}>
          <option value="">Any role</option><option value="student">Students</option><option value="teacher">Teachers</option><option value="admin">Admins</option>
        </select>
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.users.length === 0 && <Empty title="No one matches" />}
      {data && data.users.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Member ID</th><th>Organisation</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'row-muted'}>
                  <td><strong>{u.name}</strong>{u.isRoot && <span className="badge badge-approved">First admin</span>}<div className="muted small">{u.email}</div></td>
                  <td><code>{u.memberCode}</code></td>
                  <td><a href={`/t/${u.tenant.slug}/admin/users`}>{u.tenant.name}</a></td>
                  <td className="cap">{u.role}</td>
                  <td>{u.isActive ? (u.emailVerified ? 'Active' : 'Not verified') : 'Deactivated'}</td>
                  <td>{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={f.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
    </>
  );
}
