import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, UPLOAD_LIMITS_MB, api, errorMessage, safeHttpUrl, setTenantSlug, upload } from './api';
import { server } from './test/server';

beforeEach(() => setTenantSlug('acme'));

describe('api()', () => {
  it('posts {action, data} to the organisation endpoint', async () => {
    let body: unknown;
    server.use(http.post('/api/acme/auth', async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true }); }));
    await api('auth', 'login', { email: 'a@b.c' });
    expect(body).toEqual({ action: 'login', data: { email: 'a@b.c' } });
  });

  it('turns a rate limit into a message with the wait time, and exposes status and code', async () => {
    server.use(http.post('/api/acme/auth', () => HttpResponse.json({ error: 'Too many requests. Please wait a few minutes.' }, { status: 429, headers: { 'Retry-After': '300' } })));
    const err = await api('auth', 'login').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/5 minutes/);
    expect(err.retryAfterSec).toBe(300);
  });

  it('adds a support reference to server errors', async () => {
    server.use(http.post('/api/acme/auth', () => HttpResponse.json({ error: 'Something went wrong', requestId: 'abcdef12-3456' }, { status: 500 })));
    const err = await api('auth', 'me').catch((e) => e);
    expect(errorMessage(err)).toContain('reference abcdef12');
  });

  it('reports an unreachable server in plain words', async () => {
    server.use(http.post('/api/acme/auth', () => HttpResponse.error()));
    await expect(api('auth', 'login')).rejects.toThrow(/Cannot reach the server/);
  });
});

// The bucket is another origin: like a browser, jsdom asks it for permission first (the bucket's CORS setting in production).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': '*' };
const bucketHandlers = (path: string, status: number) => [
  http.options(path, () => new HttpResponse(null, { status: 204, headers: CORS })),
  http.put(path, () => new HttpResponse(null, { status, headers: CORS })),
];

describe('upload()', () => {
  const png = (size = 10) => new File([new Uint8Array(size)], 'me.png', { type: 'image/png' });

  it('refuses a file over the limit before sending anything', async () => {
    const big = new File([new Uint8Array(1)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: (UPLOAD_LIMITS_MB.photo + 1) * 1024 * 1024 });
    await expect(upload(big, 'photo')).rejects.toThrow(/at most 5 MB/);   // no handler registered: a request would fail the test
  });

  it('uses the form upload when the server says so', async () => {
    server.use(
      http.post('/api/acme/upload/init', () => HttpResponse.json({ mode: 'form', url: '/api/acme/upload?purpose=photo' })),
      http.post('/api/acme/upload', ({ request }) => {
        expect(new URL(request.url).searchParams.get('purpose')).toBe('photo');
        return HttpResponse.json({ file: { id: 'f1', name: 'me.png', size: 10, mime: 'image/png', url: '/x' } });
      }),
    );
    expect((await upload(png(), 'photo')).id).toBe('f1');
  });

  it('uploads straight to the signed address, then confirms', async () => {
    const calls: string[] = [];
    server.use(
      http.post('/api/acme/upload/init', async ({ request }) => {
        const b = (await request.json()) as { purpose: string; size: number };
        calls.push(`init:${b.purpose}:${b.size}`);
        return HttpResponse.json({ mode: 'direct', fileId: 'f2', upload: { url: 'https://storage.example/put/f2', method: 'PUT', headers: { 'Content-Type': 'image/png' } } });
      }),
      http.put('https://storage.example/put/f2', () => { calls.push('put'); return new HttpResponse(null, { status: 200, headers: CORS }); }),
      http.options('https://storage.example/put/f2', () => new HttpResponse(null, { status: 204, headers: CORS })),
      http.post('/api/acme/upload/complete', async ({ request }) => {
        calls.push(`complete:${((await request.json()) as { fileId: string }).fileId}`);
        return HttpResponse.json({ file: { id: 'f2', name: 'me.png', size: 10, mime: 'image/png', url: null } });
      }),
    );
    const f = await upload(png(), 'photo');
    expect(f.id).toBe('f2');
    expect(calls).toEqual(['init:photo:10', 'put', 'complete:f2']);
  });

  it('reports a refused direct upload', async () => {
    server.use(
      http.post('/api/acme/upload/init', () => HttpResponse.json({ mode: 'direct', fileId: 'f3', upload: { url: 'https://storage.example/put/f3', method: 'PUT', headers: {} } })),
      ...bucketHandlers('https://storage.example/put/f3', 403),
    );
    await expect(upload(png(), 'photo')).rejects.toThrow(/refused \(403\)/);
  });
});

describe('safeHttpUrl', () => {
  it('only allows web links', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
