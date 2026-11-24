import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api';
import { Alert, Button, useDocumentTitle } from '../../ui';

/** The "stop these emails" link in an invitation. It asks first: mail scanners open links automatically and must not opt people out. */
export function StopEmails() {
  useDocumentTitle('Stop invitation emails');
  const [params] = useSearchParams();
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'error'>('ask');
  const [error, setError] = useState('');

  const confirm = async () => {
    setState('busy');
    try { await api('auth', 'stopEmails', { token: params.get('token') || '' }); setState('done'); }
    catch (e) { setError(errorMessage(e)); setState('error'); }
  };

  return (
    <div className="auth-card">
      <h1>Stop invitation emails</h1>
      {state === 'done' ? <Alert tone="ok" title="Done">No organisation on this platform will be able to invite this email address any more.</Alert> : (
        <>
          <p className="muted">Choose this if you were invited to an organisation you do not know or do not want to join. Invitations to this address, from any organisation, will stop.</p>
          {state === 'error' && <Alert tone="error">{error}</Alert>}
          <Button busy={state === 'busy'} onClick={() => void confirm()}>Stop emails to this address</Button>
        </>
      )}
      <p className="auth-foot"><Link to="/">Back to the home page</Link></p>
    </div>
  );
}
