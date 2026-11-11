import { api } from '../api';
import { Loading, fmtDate, useLoad, useToast } from '../ui';

/** Referrals for one course: how many enrolled in it with the code, and who. */
export interface CourseReferrals { courseId: string; course: string; count: number; referrals: { id: string; name: string; email: string; enrolledAt: string }[] }
interface MyReferrals { code: string; link: string; count: number; courses: CourseReferrals[] }

/** "Your referral code": the member's code and link, how many enrolments used it, and who enrolled in which course. */
export function ReferralPanel() {
  const { data, loading } = useLoad(() => api<MyReferrals>('account', 'referrals'), []);
  const toast = useToast();
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
    catch { toast(`Copy failed. Select the ${what.toLowerCase()} and copy it yourself.`, 'error'); }
  };
  if (loading && !data) return <section className="panel"><Loading /></section>;
  if (!data) return null;
  return (
    <section className="panel referral-panel" id="invite" data-testid="referral-panel">
      <h2>Your referral code</h2>
      <p className="muted">Share your code with others. Learners use it when they enrol in a course.</p>
      <div className="referral-share">
        <div>
          <span className="muted small">Your referral code</span>
          <div className="referral-row"><code className="referral-code">{data.code}</code>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(data.code, 'Code')}>Copy code</button></div>
        </div>
        <div>
          <span className="muted small">Your referral link</span>
          <div className="referral-row"><code className="key-hint">{data.link}</code>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(data.link, 'Link')}>Copy link</button></div>
        </div>
      </div>
      <div className="totals referral-totals">
        <div className="stat" data-testid="referral-count"><span className="muted small">Enrolments with your code</span><strong>{data.count}</strong></div>
        <div className="stat" data-testid="referral-courses"><span className="muted small">Courses</span><strong>{data.courses.length}</strong></div>
      </div>
      {data.courses.map((c) => <CourseReferralList key={c.courseId} c={c} />)}
    </section>
  );
}

/** One course: its title, how many enrolled in it with the code, and each person. */
export function CourseReferralList({ c }: { c: CourseReferrals }) {
  return (
    <div className="course-referrals" data-testid={`course-referrals-${c.courseId}`}>
      <h3><span>{c.course}</span><span className="badge">{c.count} {c.count === 1 ? 'enrolment' : 'enrolments'}</span></h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Email</th><th>Name</th><th className="hide-sm">Enrolled</th></tr></thead>
          <tbody>
            {c.referrals.map((r) => <tr key={r.id}><td>{r.email}</td><td>{r.name}</td><td className="hide-sm">{fmtDate(r.enrolledAt)}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
