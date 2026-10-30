import { useState } from 'react';
import { api, type Role, type User } from '../../api';
import { useAuth } from '../../auth';
import { Button, Empty, Field, Loading, Modal, Pager, ReasonModal, Select, fmtDate, useAction, useDocumentTitle, useLoad, useToast } from '../../ui';
import { AdminNav } from './Dashboard';

type Row = User & { isActive: boolean; deactivatedAt: string | null; deactivatedReason: string | null };

export function AdminUsers() {
  useDocumentTitle('Users');
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const [f, setF] = useState({ q: '', role: '', status: '', page: 1 });
  const { data, loading, reload } = useLoad(() => api<{ users: Row[]; total: number; pageSize: number }>('admin', 'users', f), [f]);
  const [deactivate, setDeactivate] = useState<Row | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'student' });
  const { busy, run } = useAction();
  const toast = useToast();

  // AD-04: no Admin can change or suspend another Admin; the first Admin is fixed.
  const protectedRow = (u: Row) => u.isRoot || (u.role === 'admin' && u.id !== me?.id);

  const changeRole = (u: Row, role: Role) => {
    if (!confirm(`Change ${u.name} from ${u.role} to ${role}? They will be signed out.`)) return;
    void run(async () => { await api('admin', 'changeRole', { userId: u.id, role }); await reload(); }, 'Role changed');
  };

  return (
    <>
      <AdminNav />
      <div className="page-head row-between">
        <div><h1>Users</h1><p className="muted">Accounts are never deleted. Deactivating signs a person out and keeps their history.</p></div>
        <Button onClick={() => { setInvite({ name: '', email: '', role: 'student' }); setInviting(true); }}>Invite someone</Button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q, page: 1 }); }}>
        <input type="search" aria-label="Search users" placeholder="Name, email or member ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })}>
          <option value="">Any role</option><option value="student">Students</option><option value="teacher">Teachers</option><option value="admin">Admins</option>
        </select>
        <select aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>
          <option value="">Active and deactivated</option><option value="active">Active</option><option value="inactive">Deactivated</option>
        </select>
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.users.length === 0 && <Empty title="No users match" />}
      {data && data.users.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Member ID</th><th>Role</th><th>Status</th><th>Joined</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'row-muted'}>
                  <td><strong>{u.name}</strong>{u.isRoot && <span className="badge badge-approved">First admin</span>}<div className="muted small">{u.email}{!u.emailVerified && ' · not verified'}{u.totpEnabled && ' · authenticator on'}</div></td>
                  <td><code>{u.memberCode}</code></td>
                  <td>
                    {protectedRow(u) ? <span className="cap">{u.role}</span> : (
                      <select aria-label={`Role for ${u.name}`} value={u.role} disabled={busy || !u.isActive} onChange={(e) => changeRole(u, e.target.value as Role)}>
                        <option value="student">Student</option><option value="teacher">Teacher</option><option value="admin">Admin</option>
                      </select>
                    )}
                  </td>
                  <td>{u.isActive ? 'Active' : <span title={u.deactivatedReason ?? ''}>Deactivated {fmtDate(u.deactivatedAt)}</span>}</td>
                  <td>{fmtDate(u.createdAt)}</td>
                  <td className="cell-actions">
                    {u.isActive
                      ? (u.role !== 'admin' && <button className="link-btn danger-text" onClick={() => setDeactivate(u)}>Deactivate</button>)
                      : <button className="link-btn" disabled={busy} onClick={() => run(async () => { await api('admin', 'setActive', { userId: u.id, active: true }); await reload(); }, 'Account reactivated')}>Reactivate</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={f.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
      <Modal title="Invite someone" open={inviting} onClose={() => setInviting(false)}>
        <form onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await api('admin', 'inviteUser', invite); setInviting(false); await reload(); }, `Invitation sent to ${invite.email}`);
        }}>
          <p className="muted">They get an email with a link to set their password. Their member ID is created now.</p>
          <Field label="Full name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required />
          <Field label="Email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
          <Select label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
            <option value="student">Student</option><option value="teacher">Teacher</option>
          </Select>
          <div className="row-end">
            <Button type="button" variant="ghost" onClick={() => setInviting(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Send invitation</Button>
          </div>
        </form>
      </Modal>
      <ReasonModal open={!!deactivate} onClose={() => setDeactivate(null)} title={`Deactivate ${deactivate?.name ?? ''}`} label="Reason" minLength={3} confirmLabel="Deactivate account"
        onConfirm={async (reason) => {
          try { await api('admin', 'setActive', { userId: deactivate!.id, active: false, reason }); toast('Account deactivated'); setDeactivate(null); await reload(); }
          catch (e) { toast((e as Error).message, 'error'); }
        }} />
    </>
  );
}
