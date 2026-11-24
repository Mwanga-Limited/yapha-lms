import * as Sentry from '@sentry/react';

// Thin client for the backend's action endpoints: POST /api/<organisation>/<endpoint> { action, data },
// and POST /api/platform { action, data } for the super admin console.

/** Words that are the app's own pages, never an organisation's web address (same list as the backend's RESERVED_SLUGS). */
export const RESERVED_PATHS = new Set([
  'api', 'internal', 'platform', 'register', 't', 'admin', 'www', 'static', 'assets', 'app', 'src', 'public',
  'organisation', 'organisations', 'login', 'signup', 'sign-up', 'help', 'support', 'about', 'docs', 'status', 'health',
]);

/** The organisation this page belongs to (the first part of the address: /<slug>/...). */
let tenantSlug: string | null = null;
export const setTenantSlug = (slug: string | null) => { tenantSlug = slug; };
export const getTenantSlug = () => tenantSlug;
/** Build an API URL inside the current organisation, e.g. apiUrl('/certificates/EL-...'). */
export const apiUrl = (path: string) => `/api/${tenantSlug}${path}`;

export type Role = 'student' | 'teacher' | 'admin' | 'superadmin';
export type Endpoint = 'auth' | 'account' | 'courses' | 'learn' | 'admin' | 'payments';

export interface User {
  id: string; email: string; name: string; phone: string | null; bio: string | null; expertise: string | null;
  photoUrl: string | null; role: Role; isRoot: boolean; emailVerified: boolean; totpEnabled: boolean;
  hasPassword: boolean; googleLinked: boolean; createdAt: string;
  isSuper: boolean; memberCode: string | null; tenantId: string | null;
}

export interface TenantSettings {
  branding: { displayName: string; logoFileId: string | null; accentColor: string; primaryColor: string; header: 'dark' | 'light' };
  quiz: { passMark: number; maxAttempts: number; lockHours: number };
  access: { signup: 'open' | 'invite'; allowedDomains: string[] };
  auth: { google: boolean; studentMfa: boolean };
  payments: { currency: Currency };
}
export const CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES', 'USD'] as const;
export type Currency = typeof CURRENCIES[number];

/** What every page of an organisation knows about it (public, no secrets). */
export interface TenantInfo {
  id: string; slug: string; name: string; legalName: string; status: 'active' | 'suspended';
  branding: { accentColor: string; primaryColor: string; header: 'dark' | 'light'; logoUrl: string | null };
  quiz: TenantSettings['quiz'];
  access: TenantSettings['access'];
  auth: TenantSettings['auth'];
  payments?: TenantSettings['payments'];
}

export type CourseStatus = 'draft' | 'in_review' | 'rejected' | 'approved' | 'published' | 'unpublished' | 'archived';
export type VersionStatus = 'draft' | 'in_review' | 'rejected' | 'approved' | 'superseded';
export type Level = 'beginner' | 'intermediate' | 'advanced';
export type LessonType = 'video' | 'text' | 'file';

export interface CourseMeta {
  id: string; slug: string; title: string; summary: string; description: string; outline: string; category: string; level: Level;
  language: string; thumbnailFileId: string | null; thumbnailUrl: string | null; status: CourseStatus;
  publishedAt: string | null; createdAt: string; updatedAt: string; teacherId: string;
  /** In the smallest unit (kobo…). price is what learners pay (set by the Admin; every course is paid, 0 = not priced yet); suggestedPrice is the teacher's suggestion. */
  price: number; suggestedPrice: number; currency: Currency;
}

export interface QuizState {
  attemptsUsed: number; attemptsLeft: number; maxAttempts: number; passMark: number;
  lockedUntil: string | null; passed: boolean; score: number | null;
}

export interface OutlineItem {
  id: string; kind: 'lesson' | 'quiz'; title: string; required: boolean;
  type?: LessonType; preview?: boolean; durationMin?: number | null; questionCount?: number;
  done?: boolean; state?: QuizState;
}
export interface OutlineSection { id: string; title: string; items: OutlineItem[] }

export type { WatchState } from './watch';
export interface LessonPayload {
  id: string; title: string; type: LessonType; body: string; videoUrl: string | null;
  fileUrl: string | null; fileName: string | null; durationMin: number | null;
}

// ---- authoring content (stored per course version)
export interface Option { id: string; text: string }
export interface Question { id: string; type: 'single' | 'multi' | 'truefalse'; prompt: string; options: Option[]; correct: string[] }
export interface LessonItem {
  id: string; kind: 'lesson'; title: string; type: LessonType; body: string; videoUrl: string;
  fileId: string | null; fileName: string; preview: boolean; durationMin: number | null;
}
export interface QuizItem { id: string; kind: 'quiz'; title: string; description: string; questions: Question[] }
export type Item = LessonItem | QuizItem;
export interface Section { id: string; title: string; items: Item[] }
export interface Content { sections: Section[]; completion: { lessons: string[]; quizzes: string[] } }

export interface Progress { total: number; done: number; percent: number; ruleMet?: boolean }

export interface Notification { id: string; type: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown> | null, public retryAfterSec: number | null = null) { super(message); }
  /** Support reference of the failed request (the server's X-Request-Id). */
  get requestId(): string | undefined { return this.data?.requestId as string | undefined; }
  get problems(): string[] { return (this.data?.problems as string[]) ?? []; }
  get code(): string | undefined { return this.data?.code as string | undefined; }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, null);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'));
    const retryAfterSec = res.status === 429 && Number.isFinite(retry) && retry > 0 ? retry : null;
    const data = { ...(body ?? {}), requestId: body?.requestId ?? res.headers.get('x-request-id') ?? undefined };
    // Rate limited: say how long to wait. Never retried automatically, so a limit is not made worse by the app itself.
    const wait = retryAfterSec ? ` Try again in about ${retryAfterSec >= 90 ? `${Math.ceil(retryAfterSec / 60)} minutes` : `${retryAfterSec} seconds`}.` : '';
    const base: string = body?.error || `Request failed (${res.status})`;
    const message = retryAfterSec && /few minutes/i.test(base) ? `Too many requests.${wait}` : base;
    const apiError = new ApiError(message, res.status, data, retryAfterSec);
    // Server faults only (not validation, auth or rate limits). The request id links this report to the backend's log lines.
    if (res.status >= 500) Sentry.withScope((scope) => { scope.setTag('requestId', apiError.requestId ?? 'none'); scope.setTag('status', String(res.status)); Sentry.captureException(apiError); });
    throw apiError;
  }
  return body as T;
}

// The first request of every page is `me`. React (and the router) can ask for it twice at once; share one request.
const inFlight = new Map<string, Promise<unknown>>();
function shared<T>(key: string, start: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = start().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function api<T = any>(endpoint: Endpoint, action: string, data: unknown = {}, opts: { keepalive?: boolean } = {}): Promise<T> {
  const url = apiUrl(`/${endpoint}`);
  const send = () => request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
    ...(opts.keepalive ? { keepalive: true } : {}),   // still sent if the learner closes the tab
  });
  return action === 'me' ? shared(`${url}#me`, send) : send();
}

/** Super admin console: POST /api/platform { action, data }. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function platformApi<T = any>(action: string, data: unknown = {}): Promise<T> {
  return request<T>('/api/platform', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
}

/** Public organisation registration: POST /api/organisations { action, data }. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function organisationsApi<T = any>(action: string, data: unknown = {}): Promise<T> {
  return request<T>('/api/organisations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
}

export type UploadPurpose = 'photo' | 'thumbnail' | 'lesson_file' | 'lesson_video' | 'logo';
export interface UploadedFile { id: string; name: string; size: number; mime: string; url: string | null }

/** Size caps per kind of file: the same as the server's, checked here first so people see the problem before a long upload. */
export const UPLOAD_LIMITS_MB: Record<UploadPurpose, number> = { photo: 5, thumbnail: 5, logo: 2, lesson_file: 50, lesson_video: 500 };

type UploadInit =
  | { mode: 'form'; url: string }
  | { mode: 'direct'; fileId: string; upload: { url: string; method: string; headers: Record<string, string> } };

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(`The upload was refused (${xhr.status}). Try again.`, xhr.status, null)));
    xhr.onerror = () => reject(new ApiError('The upload was interrupted. Check your connection and try again.', 0, null));
    xhr.send(file);
  });
}

/** Upload a file. The server says how: straight to cloud storage (a signed address; large files never pass through the app),
 *  or as a normal form post (development and single-server installs). */
export async function upload(file: File, purpose: UploadPurpose, onProgress?: (fraction: number) => void): Promise<UploadedFile> {
  const max = UPLOAD_LIMITS_MB[purpose];
  if (file.size > max * 1024 * 1024) throw new ApiError(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Files of this kind can be at most ${max} MB.`, 413, null);
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // The purpose and size are declared first, so the server can refuse before any file bytes move.
  const init = await request<UploadInit>(apiUrl('/upload/init'), json({ purpose, name: file.name, mime: file.type || 'application/octet-stream', size: file.size }));
  if (init.mode === 'direct') {
    await putWithProgress(init.upload.url, init.upload.headers, file, onProgress);
    return (await request<{ file: UploadedFile }>(apiUrl('/upload/complete'), json({ fileId: init.fileId }))).file;
  }
  const form = new FormData();
  form.append('file', file);
  const r = await request<{ file: UploadedFile }>(`${apiUrl('/upload')}?purpose=${encodeURIComponent(purpose)}`, { method: 'POST', body: form });
  onProgress?.(1);
  return r.file;
}

/** Only web links may become clickable: a stored `javascript:` or `data:` address is shown as text, never linked. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const errorMessage = (e: unknown) => {
  if (!(e instanceof Error)) return 'Something went wrong';
  // Unexpected server errors carry a reference, so support can find the exact request in the logs.
  return e instanceof ApiError && e.status >= 500 && e.requestId ? `${e.message} (reference ${e.requestId.slice(0, 8)})` : e.message;
};
