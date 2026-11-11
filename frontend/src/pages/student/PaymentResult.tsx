import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../api';
import { formatMoney } from '../../money';
import { Button, Loading, useDocumentTitle } from '../../ui';

interface Verified {
  payment: { reference: string; status: 'pending' | 'success' | 'failed'; amount: number; currency: string; failure: string | null };
  courseId: string;
  courseSlug: string;
}

/**
 * Paystack sends the learner back here (/payment?reference=…). The server asks Paystack how the payment went;
 * on success the learner already has access to the course.
 */
export function PaymentResult() {
  const [params] = useSearchParams();
  const reference = params.get('reference') || params.get('trxref') || '';
  const [result, setResult] = useState<Verified | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  useDocumentTitle('Payment');

  const check = async () => {
    setChecking(true); setError(null);
    try { setResult(await api<Verified>('payments', 'verify', { reference })); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'We could not check your payment.'); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (reference) void check(); else setChecking(false); }, [reference]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!reference) return <div className="pay-result"><h1>No payment to check</h1><p className="muted">Open a course and choose Buy to pay for it.</p><Link className="btn btn-primary" to="/">Browse courses</Link></div>;
  if (checking && !result) return <div className="pay-result"><Loading /><p className="muted">Confirming your payment with Paystack…</p></div>;
  if (error) {
    return (
      <div className="pay-result" data-testid="pay-error">
        <h1>We couldn't confirm your payment yet</h1>
        <p>{error}</p>
        <p className="muted small">If money left your account, don't pay again: your access is added as soon as Paystack confirms. Reference: {reference}</p>
        <div className="row-gap"><Button busy={checking} onClick={check}>Check again</Button><Link className="btn btn-secondary" to="/">Browse courses</Link></div>
      </div>
    );
  }
  const p = result!.payment;
  const amount = formatMoney(p.amount, p.currency);
  if (p.status === 'success') {
    return (
      <div className="pay-result" data-testid="pay-success">
        <h1>Payment successful</h1>
        <p>We received {amount}. You now have full access to the course. A receipt is on its way to your email.</p>
        <p className="muted small">Reference: {p.reference}</p>
        <div className="row-gap"><Link className="btn btn-primary btn-lg" to={`/learn/${result!.courseSlug}`}>Start learning</Link></div>
      </div>
    );
  }
  if (p.status === 'failed') {
    return (
      <div className="pay-result" data-testid="pay-failed">
        <h1>Payment not completed</h1>
        <p>Your payment of {amount} did not go through{p.failure ? `: ${p.failure}` : ''}. You can try again; if money left your account, contact your administrator with the reference {p.reference}.</p>
        <div className="row-gap"><Link className="btn btn-primary" to={`/courses/${result!.courseSlug}`}>Try again</Link></div>
      </div>
    );
  }
  return (
    <div className="pay-result" data-testid="pay-pending">
      <h1>Payment not finished</h1>
      <p>Paystack hasn't confirmed this payment yet. If you closed the payment window, go back to the course and try again.</p>
      <p className="muted small">Reference: {p.reference}</p>
      <div className="row-gap"><Button busy={checking} onClick={check}>Check again</Button><Link className="btn btn-secondary" to={`/courses/${result!.courseSlug}`}>Back to the course</Link></div>
    </div>
  );
}
