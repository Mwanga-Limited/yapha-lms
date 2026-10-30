import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { platformApi } from '../api';
import { Button, Empty, Loading, Pager, fmtDateTime, useAction, useDocumentTitle, useLoad } from '../ui';
import type { TenantRow } from './types';

interface Entry { id: number; created_at: string; tenant_slug: string | null; tenant_name: string | null; actor_email: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; old_values: unknown; new_values: unknown; ip: string | null }
const show = (v: unknown) => (v == null ? '' : JSON.stringify(v, null, 1).replace(/^\{\n?|\n?\}$/g, '').replace(/"/g, ''));

/** Audit log across organisations, filterable to one organisation or to platform-level events. */
export function PlatformAudit() {
  useDocumentTitle('Audit log');
  const [params] = useSearchParams();
  const blank = { tenantId: params.get('tenant') ?? '', actor: '', action: '', from: '', to: '' };
  const [form, setForm] = useState(blank);
  const [f, setF] = useState({ ...blank, page: 1 });
  const tenants = useLoad(() => platformApi<{ tenants: TenantRow[] }>('tenants'), []);
  const { data, loading } = useLoad(() => platformApi<{ entries: Entry[]; total: number; pageSize: number; actions: string[] }>('audit', f), [f]);
  const { busy, run } = useAction();

  const exportCsv = () => run(async () => {
    const r = await platformApi<{ csv: string; filename: string }>('auditCsv', f);
    const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: r.filename }).click();
    URL.revokeObjectURL(url);
  }, 'CSV downloaded');

  return (
    <>
      <div className="page-head row-between">
        <div><h1>Audit log</h1><p className="muted">Every organisation's log plus platform events. Entries can never be edited or deleted.</p></div>
        <Button variant="secondary" busy={busy} onClick={exportCsv}>Export CSV</Button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setF({ ...form, page: 1 }); }}>
        <select aria-label="Organisation" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
          <option value="">All organisations and platform</option>
          <option value="platform">Platform events only</option>
          {tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
        </select>
        <input type="search" aria-label="Actor email" placeholder="Actor email" value={form.actor} onChange={(e) => setForm({ ...form, actor: e.target.value })} />
        <select aria-label="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
          <option value="">Any action</option>
          {data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <label className="date-filter">From <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
        <label className="date-filter">To <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
        <button className="btn btn-secondary" type="submit">Filter</button>
      </form>
      {loading && !data && <Loading />}
      {data && <p className="muted small">{data.total} entries</p>}
      {data && data.entries.length === 0 && <Empty title="No entries match these filters" />}
      {data && data.entries.length > 0 && (
        <div className="table-wrap">
          <table className="table audit">
            <thead><tr><th>When</th><th>Organisation</th><th>Actor</th><th>Action</th><th>Change</th><th>IP</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} className={/blocked|failed/.test(e.action) ? 'row-alert' : ''}>
                  <td className="nowrap">{fmtDateTime(e.created_at)}</td>
                  <td className="small">{e.tenant_name ?? <span className="muted">Platform</span>}</td>
                  <td>{e.actor_email ?? <span className="muted">system</span>}{e.actor_role && <div className="muted small">{e.actor_role}</div>}</td>
                  <td><code>{e.action}</code>{e.target_type && <div className="muted small">{e.target_type}</div>}</td>
                  <td className="small change">
                    {e.old_values != null && <div><span className="muted">from</span> <pre>{show(e.old_values)}</pre></div>}
                    {e.new_values != null && <div><span className="muted">to</span> <pre>{show(e.new_values)}</pre></div>}
                  </td>
                  <td className="small nowrap">{e.ip}</td>
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
