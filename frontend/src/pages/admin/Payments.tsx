import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { formatMoney } from '../../money';
import { Empty, Loading, Pager, fmtDateTime, useDocumentTitle, useLoad } from '../../ui';
import { AdminNav } from './Dashboard';

interface Payment {
  id: string; reference: string; amount: number; currency: string; status: 'pending' | 'success' | 'failed'; liveMode: boolean;
  channel: string | null; paidAt: string | null; failure: string | null; createdAt: string;
  learner: { name: string; email: string }; course: { id: string; title: string };
}
interface List { payments: Payment[]; total: number; pageSize: number; totals: { currency: string; liveMode: boolean; amount: number; count: number }[] }

const STATUS = { success: 'Paid', pending: 'Not finished', failed: 'Failed' } as const;

/** Payments learners made for this organisation's courses (through its Paystack account). */
export function AdminPayments() {
  useDocumentTitle('Payments');
  const [f, setF] = useState<{ status: '' | 'success' | 'pending' | 'failed'; page: number }>({ status: 'success', page: 1 });
  const { data, loading } = useLoad(() => api<List>('payments', 'list', f), [f]);
  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Payments</h1><Link className="btn btn-secondary" to="/admin/settings#payments">Paystack settings</Link></div>
      {data && data.totals.length > 0 && (
        <div className="totals">
          {data.totals.map((t) => (
            <div className="stat" key={`${t.currency}-${t.liveMode}`}>
              <span className="muted small">Received{t.liveMode ? '' : ' (test mode)'}</span>
              <strong>{formatMoney(t.amount, t.currency)}</strong>
              <span className="muted small">{t.count} {t.count === 1 ? 'payment' : 'payments'}</span>
            </div>
          ))}
        </div>
      )}
      <div className="toolbar">
        <select aria-label="Status" value={f.status} onChange={(e) => setF({ status: e.target.value as typeof f.status, page: 1 })}>
          <option value="success">Paid</option><option value="pending">Not finished</option><option value="failed">Failed</option><option value="">All</option>
        </select>
      </div>
      {loading && !data && <Loading />}
      {data && data.payments.length === 0 && <Empty title="No payments yet">Payments appear here when learners buy courses.</Empty>}
      {data && data.payments.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Learner</th><th>Course</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.paidAt ?? p.createdAt)}</td>
                  <td>{p.learner.name}<div className="muted small">{p.learner.email}</div></td>
                  <td><Link to={`/admin/courses/${p.course.id}`}>{p.course.title}</Link></td>
                  <td>{formatMoney(p.amount, p.currency)}{!p.liveMode && <div className="muted small">test</div>}</td>
                  <td>
                    <span className={p.status === 'success' ? 'ok-text' : p.status === 'failed' ? 'warn-text' : 'muted'}>{STATUS[p.status]}</span>
                    {p.failure && <div className="muted small">{p.failure}</div>}
                    {p.channel && <div className="muted small">{p.channel}</div>}
                  </td>
                  <td><code className="small">{p.reference}</code></td>
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
