// Paystack test server: a local copy of the parts of the Paystack API the app uses, so payment tests run
// without the internet or real money.
// It answers /transaction/initialize and /transaction/verify the way Paystack does, for the secret keys it knows.
import crypto from 'node:crypto';
import http from 'node:http';

export async function startPaystackTestServer() {
  const keys = new Set();                 // secret keys Paystack would accept
  const transactions = new Map();         // reference -> { request, outcome }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const key = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!keys.has(key)) return send(401, { status: false, message: 'Invalid key' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};

    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      if (!body.email || !Number.isInteger(body.amount) || !body.reference) return send(400, { status: false, message: 'Invalid request' });
      transactions.set(body.reference, { key, request: body, outcome: { status: 'success' } });
      return send(200, { status: true, message: 'Authorization URL created',
        data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: crypto.randomUUID(), reference: body.reference } });
    }
    const m = req.method === 'GET' && req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (m) {
      const t = transactions.get(decodeURIComponent(m[1]));
      if (!t || t.key !== key) return send(400, { status: false, message: 'Transaction reference not found' });
      return send(200, { status: true, message: 'Verification successful', data: transactionData(t) });
    }
    send(404, { status: false, message: 'Not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    acceptKey: (k) => keys.add(k),
    /** What Paystack will report for this payment: { status: 'success'|'failed'|'abandoned', amount?, currency? } */
    setOutcome: (reference, outcome) => { transactions.get(reference).outcome = outcome; },
    request: (reference) => transactions.get(reference)?.request,
    transaction: (reference) => transactionData(transactions.get(reference)),
    close: () => new Promise((r) => server.close(r)),
    unref: () => server.unref(),   // don't keep the test process alive
  };
}

/** A transaction as Paystack reports it (from /transaction/verify and in webhooks). */
function transactionData(t) {
  return {
    id: 1000 + Math.floor(Math.random() * 1e6), status: t.outcome.status, reference: t.request.reference,
    amount: t.outcome.amount ?? t.request.amount, currency: t.outcome.currency ?? t.request.currency ?? 'NGN',
    channel: 'card', gateway_response: t.outcome.status === 'success' ? 'Successful' : 'Declined',
    paid_at: t.outcome.status === 'success' ? new Date().toISOString() : null,
    customer: { email: t.request.email }, metadata: t.request.metadata,
  };
}

/** Sign a webhook body the way Paystack does. */
export const signWebhook = (secretKey, body) => crypto.createHmac('sha512', secretKey).update(body).digest('hex');
