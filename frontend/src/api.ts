// Thin client for the backend's action endpoints: POST /api/t/<organisation>/<endpoint> { action, data },
// and POST /api/platform { action, data } for the super admin console.

/** The organisation this page belongs to (from the /t/<slug> part of the address). */
let tenantSlug: string | null = null;
export const setTenantSlug = (slug: string | null) => { tenantSlug = slug; };
export const getTenantSlug = () => tenantSlug;
/** Build an API URL inside the current organisation, e.g. apiUrl('/certificates/EL-...'). */
export const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

export type Role = 'student' | 'teacher' | 'admin' | 'superadmin';
export type Endpoint = 'auth' | 'account' | 'courses' | 'learn' | 'admin';

export interface User {
  id: string; email: string; name: string; phone: string | null; bio: string | null; expertise: string | null;
  photoUrl: string | null; role: Role; isRoot: boolean; emailVerified: boolean; totpEnabled: boolean;
  hasPassword: boolean; googleLinked: boolean; createdAt: string;
  isSuper: boolean; memberCode: string | null; tenantId: string | null;
}

export interface TenantSettings {
  branding: { displayName: string; logoFileId: string | null; accentColor: string };
  quiz: { passMark: number; maxAttempts: number; lockHours: number };
  access: { signup: 'open' | 'invite'; allowedDomains: string[] };
  auth: { google: boolean; studentMfa: boolean };
}

/** What every page of an organisation knows about it (public, no secrets). */
export interface TenantInfo {
  id: string; slug: string; name: string; legalName: string; status: 'active' | 'suspended';
  branding: { accentColor: string; logoUrl: string | null };
  quiz: TenantSettings['quiz'];
  access: TenantSettings['access'];
  auth: TenantSettings['auth'];
}

export type CourseStatus = 'draft' | 'in_review' | 'rejected' | 'approved' | 'published' | 'unpublished' | 'archived';
export type VersionStatus = 'draft' | 'in_review' | 'rejected' | 'approved' | 'superseded';
export type Level = 'beginner' | 'intermediate' | 'advanced';
export type LessonType = 'video' | 'text' | 'file';

export interface CourseMeta {
  id: string; title: string; summary: string; description: string; outline: string; category: string; level: Level;
  language: string; thumbnailFileId: string | null; thumbnailUrl: string | null; status: CourseStatus;
  publishedAt: string | null; createdAt: string; updatedAt: string; teacherId: string;
}

export interface QuizState {
  attemptsUsed: number; attemptsLeft: number; maxAttempts: number; passMark: number;
  lockedUntil: string | null; passed: boolean; bestScore: number | null;
}

export interface OutlineItem {
  id: string; kind: 'lesson' | 'quiz'; title: string; required: boolean;
  type?: LessonType; preview?: boolean; durationMin?: number | null; questionCount?: number;
  done?: boolean; state?: QuizState;
}
export interface OutlineSection { id: string; title: string; items: OutlineItem[] }

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
  constructor(message: string, public status: number, public data: Record<string, unknown> | null) { super(message); }
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
  if (!res.ok) throw new ApiError(body?.error || `Request failed (${res.status})`, res.status, body);
  return body as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function api<T = any>(endpoint: Endpoint, action: string, data: unknown = {}): Promise<T> {
  return request<T>(apiUrl(`/${endpoint}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
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

export type UploadPurpose = 'photo' | 'thumbnail' | 'lesson_file' | 'lesson_video' | 'logo';
export interface UploadedFile { id: string; name: string; size: number; mime: string; url: string | null }

export async function upload(file: File, purpose: UploadPurpose): Promise<UploadedFile> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file);
  const r = await request<{ file: UploadedFile }>(apiUrl('/upload'), { method: 'POST', body: form });
  return r.file;
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
