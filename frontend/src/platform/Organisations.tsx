import { useState } from 'react';
import { Link } from 'react-router-dom';
import { platformApi } from '../api';
import { Empty, Loading, StatusBadge, fmtDate, useDocumentTitle, useLoad } from '../ui';
import type { TenantRow } from './types';

export function Organisations() {
  useDocumentTitle('Organisations');
  const [q, setQ] = useState('');
  const [f, setFilter] = useState({ q: '', status: '' });
  const { data, loading } = useLoad(() => platformApi<{ tenants: TenantRow[] }>('tenants', f), [f]);

  return (
    <>
      <div className="page-head row-between">
        <div><h1>Organisations</h1><p className="muted">Organisations register themselves at <a href="/register">/register</a>. Each one has its own members, courses, rules and audit log. You can review, configure or suspend them here.</p></div>
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
                  <span className="muted small">/{t.slug} · created {fmtDate(t.createdAt)}</span>
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
    </>
  );
}
