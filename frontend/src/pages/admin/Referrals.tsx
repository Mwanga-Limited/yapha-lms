import { useState } from 'react';
import { api } from '../../api';
import { Empty, Loading, Pager, useDocumentTitle, useLoad } from '../../ui';
import { AdminNav } from './Dashboard';
import { CourseReferralList, type CourseReferrals } from '../../components/ReferralPanel';

interface Referrer { id: string; name: string; email: string; memberCode: string | null; role: string; code: string; count: number; courses: CourseReferrals[] }
interface List { referrers: Referrer[]; total: number; pageSize: number; totals: { referrals: number; referrers: number } }

/** Teachers and students whose referral code was used when enrolling: how many enrolments, and who enrolled in which course. */
export function AdminReferrals() {
  useDocumentTitle('Referrals');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ q: '', page: 1 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data, loading } = useLoad(() => api<List>('admin', 'referrals', f), [f]);
  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Referrals</h1><p className="muted">Teachers and students whose referral code learners used when enrolling in a course.</p></div>
      {data && (
        <div className="totals">
          <div className="stat"><span className="muted small">Enrolments with a referral code</span><strong>{data.totals.referrals}</strong></div>
          <div className="stat"><span className="muted small">Members whose code was used</span><strong>{data.totals.referrers}</strong></div>
        </div>
      )}
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setF({ q, page: 1 }); }}>
        <input type="search" aria-label="Search referrals" placeholder="Name, email or referral code" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-secondary" type="submit">Search</button>
      </form>
      {loading && !data && <Loading />}
      {data && data.referrers.length === 0 && <Empty title={f.q ? 'No referrals match your search' : 'No referrals yet'}>Teachers and students find their referral code on their account page. Learners enter it when they enrol.</Empty>}
      {data && data.referrers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Referrer</th><th>Code</th><th>Enrolments</th><th>Courses</th><th></th></tr></thead>
            <tbody>
              {data.referrers.map((r) => (
                <ReferrerRow key={r.id} r={r} open={!!open[r.id]} toggle={() => setOpen({ ...open, [r.id]: !open[r.id] })} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={f.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setF({ ...f, page: p })} />}
    </>
  );
}

function ReferrerRow({ r, open, toggle }: { r: Referrer; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr className="referrer-row">
        <td><strong>{r.name}</strong><div className="muted small">{r.email} · {r.role}{r.memberCode ? ` · ${r.memberCode}` : ''}</div></td>
        <td><code>{r.code}</code></td>
        <td><strong>{r.count}</strong></td>
        <td>{r.courses.length}</td>
        <td><button type="button" className="link-btn" aria-expanded={open} onClick={toggle}>{open ? 'Hide' : 'Show who enrolled'}</button></td>
      </tr>
      {open && (
        <tr><td colSpan={5}>
          <div className="referees-table" data-testid={`referees-${r.code}`}>
            {r.courses.map((c) => <CourseReferralList key={c.courseId} c={c} />)}
          </div>
        </td></tr>
      )}
    </>
  );
}
