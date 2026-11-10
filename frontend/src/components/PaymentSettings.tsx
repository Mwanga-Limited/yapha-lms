import { useState } from 'react';
import { api } from '../api';
import { Alert, Button, Field, Loading, fmtDateTime, useAction, useLoad } from '../ui';

interface Account {
  connected: boolean;
  needsReconnect: boolean;
  account: { publicKey: string; secretKeyHint: string; liveMode: boolean; updatedAt: string } | null;
  currency: string;
  webhookUrl: string;
}

/**
 * The organisation's own Paystack account: learners' course payments go straight to it.
 * The secret key is sent once, stored encrypted, and never shown again (only its last 4 characters).
 */
export function PaymentSettings() {
  const { data, loading, reload } = useLoad(() => api<Account>('payments', 'account'), []);
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState({ publicKey: '', secretKey: '' });
  const { busy, run } = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const showForm = !data.connected || data.needsReconnect || editing;

  const save = () => run(async () => {
    await api('payments', 'saveAccount', keys);
    setKeys({ publicKey: '', secretKey: '' }); setEditing(false);
    await reload();
  }, 'Paystack connected');
  const remove = () => run(async () => { await api('payments', 'removeAccount'); await reload(); }, 'Paystack disconnected');

  return (
    <div data-testid="payment-settings">
      {data.needsReconnect && (
        <Alert tone="error" title="Enter your Paystack keys again">
          The saved secret key can't be read on this server (the server's DATA_ENCRYPTION_KEY has changed since it was saved). Learners can't pay until you save the keys again.
        </Alert>
      )}
      {data.connected && data.account && !data.needsReconnect && (
        <>
          <Alert tone={data.account.liveMode ? 'ok' : 'warn'} title={data.account.liveMode ? 'Paystack connected (live)' : 'Paystack connected in test mode'}>
            {data.account.liveMode ? 'Learners can pay for courses with real money.' : 'Payments use Paystack test cards; no real money is taken. Enter your live keys when you are ready.'}
          </Alert>
          <dl className="kv">
            <dt>Public key</dt><dd className="key-hint">{data.account.publicKey}</dd>
            <dt>Secret key</dt><dd className="key-hint">{data.account.secretKeyHint}</dd>
            <dt>Last updated</dt><dd>{fmtDateTime(data.account.updatedAt)}</dd>
          </dl>
        </>
      )}
      {!data.connected && <p>Connect your organisation's Paystack account so learners can pay for courses. Payments go straight to your Paystack account.</p>}
      {showForm ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Public key" placeholder="pk_test_… or pk_live_…" value={keys.publicKey} autoComplete="off" spellCheck={false}
            onChange={(e) => setKeys({ ...keys, publicKey: e.target.value.trim() })} required />
          <Field label="Secret key" type="password" placeholder="sk_test_… or sk_live_…" value={keys.secretKey} autoComplete="new-password"
            hint="Paystack dashboard → Settings → API Keys & Webhooks. Stored encrypted and never shown again."
            onChange={(e) => setKeys({ ...keys, secretKey: e.target.value.trim() })} required />
          <div className="row-gap">
            <Button type="submit" busy={busy} disabled={!keys.publicKey || !keys.secretKey}>{data.connected ? 'Save new keys' : 'Connect Paystack'}</Button>
            {editing && <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </form>
      ) : (
        <div className="row-gap">
          <Button variant="secondary" onClick={() => setEditing(true)}>Change keys</Button>
          <Button variant="secondary" busy={busy} onClick={remove}>Disconnect</Button>
        </div>
      )}
      <div className="field webhook-field">
        <label>Webhook URL</label>
        <code className="key-hint">{data.webhookUrl}</code>
        <small className="hint">Paste this into Paystack → Settings → API Keys &amp; Webhooks → Webhook URL. Paystack uses it to confirm payments even if a learner closes the page before returning.</small>
      </div>
    </div>
  );
}
