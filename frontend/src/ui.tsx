import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { errorMessage, type CourseStatus } from './api';

// ------------------------------------------------------------------ data loading
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fnRef.current()); setError(null); } catch (e) { setError(e); } finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, loading, reload, setData };
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: busy flag + error toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ------------------------------------------------------------------ primitives
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean; small?: boolean };
export function Button({ variant = 'primary', busy, small, className = '', children, disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} ${small ? 'btn-sm' : ''} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

interface FieldShell { label: string; hint?: ReactNode; error?: string; }
export function Field({ label, hint, error, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={!!error || undefined} aria-describedby={hint ? `${id}-h` : undefined} {...rest} />
      {hint && <small id={`${id}-h`} className="hint">{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}
export function TextArea({ label, hint, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} {...rest} />
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}
export function Select({ label, hint, children, ...rest }: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...rest}>{children}</select>
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'ok' | 'warn' | 'error'; children?: ReactNode; title?: string }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="loading"><span className="spinner" aria-hidden /> {label}…</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert tone="error" title="This could not be loaded">
      <p>{errorMessage(error)}</p>
      {onRetry && <Button small variant="secondary" onClick={onRetry}>Try again</Button>}
    </Alert>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}

/** The highlighter-stroke progress bar. */
export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <div className="progress-track"><div className="progress-ink" style={{ width: `${p}%` }} /></div>
      <span className="progress-num">{p}%</span>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', in_review: 'In review', rejected: 'Rejected', approved: 'Approved', published: 'Published',
  unpublished: 'Unpublished', archived: 'Archived', superseded: 'Superseded', pending: 'Pending', declined: 'Declined',
};
export function StatusBadge({ status }: { status: CourseStatus | string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Modal({ title, open, onClose, children, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="modal-body">{open && children}</div>
    </dialog>
  );
}

/** Ask for a required reason, then run onConfirm(reason). */
export function ReasonModal({ open, title, label, confirmLabel, minLength = 5, onClose, onConfirm, danger = true }: {
  open: boolean; title: string; label: string; confirmLabel: string; minLength?: number; danger?: boolean;
  onClose: () => void; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }}>
        <TextArea label={label} value={reason} onChange={(e) => setReason(e.target.value)} rows={4} required minLength={minLength} autoFocus
          hint={`At least ${minLength} characters. The person affected will see this.`} />
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy} disabled={reason.trim().length < minLength}>{confirmLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <Button small variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button small variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ formatting
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const levelLabel = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function timeAgo(d: string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(d);
}

export function useDocumentTitle(title: string) {
  useEffect(() => { document.title = title ? `${title} — Learn` : 'Learn'; }, [title]);
}
