import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Loading, useDocumentTitle } from '../../ui';

export function VerifyEmail() {
  useDocumentTitle('Verify email');
  const [params] = useSearchParams();
  const { refresh, user } = useAuth();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('auth', 'verifyEmail', { token: params.get('token') || '' })
      .then(() => { setState('ok'); void refresh(); })
      .catch((e) => { setError(errorMessage(e)); setState('error'); });
  }, [params, refresh]);

  return (
    <div className="auth-card">
      <h1>Email verification</h1>
      {state === 'working' && <Loading label="Checking your link" />}
      {state === 'ok' && <Alert tone="ok" title="Your email is verified">You can now enrol in courses{user?.role !== 'student' ? ' and submit courses for review' : ''}.</Alert>}
      {state === 'error' && <Alert tone="error" title="This link didn't work">{error} Sign in and use “Send it again” in the banner to get a new link.</Alert>}
      <p className="auth-foot"><Link to={user ? '/dashboard' : '/login'}>{user ? 'Go to my learning' : 'Sign in'}</Link></p>
    </div>
  );
}
