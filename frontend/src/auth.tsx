import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, type Role, type TenantInfo, type User } from './api';
import { setSiteName } from './ui';

interface AuthState {
  user: User | null;
  tenant: TenantInfo | null;
  /** Why the organisation can't be used: not found, or suspended. */
  tenantError: 'not_found' | 'suspended' | null;
  loading: boolean;
  googleClientId: string | null;
  setUser: (u: User | null) => void;
  setTenant: (t: TenantInfo) => void;
  refresh: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Apply the organisation's accent colour (the highlighter) to the whole interface. */
const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
/** The colour mixed with white: share 0 = unchanged, 1 = white. */
const tint = (hex: string, share: number) => `rgb(${rgb(hex).map((c) => Math.round(c + (255 - c) * share)).join(', ')})`;
/** The colour mixed with black: readable as small text on light backgrounds. */
const shade = (hex: string, share: number) => `rgb(${rgb(hex).map((c) => Math.round(c * (1 - share))).join(', ')})`;

/** The organisation's colours: accent (highlights) and primary (header, headings, buttons). */
export function applyBranding(accent: string | undefined, primary?: string) {
  const root = document.documentElement;
  if (accent && HEX.test(accent)) {
    root.style.setProperty('--hl', accent);
    root.style.setProperty('--hl-soft', tint(accent, 0.72));
    root.style.setProperty('--hl-wash', tint(accent, 0.9));
    root.style.setProperty('--hl-dot', tint(accent, 0.6));
    root.style.setProperty('--hl-ink', shade(accent, 0.4));
    root.style.setProperty('--hl-strong', shade(accent, 0.22));
  } else { for (const v of ['--hl', '--hl-soft', '--hl-wash', '--hl-dot', '--hl-ink', '--hl-strong']) root.style.removeProperty(v); }
  if (primary && HEX.test(primary)) {
    root.style.setProperty('--ink', primary);
    root.style.setProperty('--ink-2', tint(primary, 0.18));
    root.style.setProperty('--ink-3', tint(primary, 0.38));
  } else { root.style.removeProperty('--ink'); root.style.removeProperty('--ink-2'); root.style.removeProperty('--ink-3'); }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenantState] = useState<TenantInfo | null>(null);
  const [tenantError, setTenantError] = useState<AuthState['tenantError']>(null);
  const [loading, setLoading] = useState(true);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  const setTenant = useCallback((t: TenantInfo) => {
    setTenantState(t);
    setSiteName(t.name);
    applyBranding(t.branding.accentColor, t.branding.primaryColor);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User | null; tenant: TenantInfo; googleClientId: string | null }>('auth', 'me');
      setUser(r.user);
      setTenant(r.tenant);
      setGoogleClientId(r.googleClientId);
      setTenantError(null);
      return r.user;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TENANT_NOT_FOUND') setTenantError('not_found');
      if (e instanceof ApiError && e.code === 'TENANT_SUSPENDED') setTenantError('suspended');
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [setTenant]);

  const logout = useCallback(async () => {
    await api('auth', 'logout').catch(() => {});
    setUser(null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, tenant, tenantError, loading, googleClientId, setUser, setTenant, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** The organisation of this page (always loaded once the app is shown). */
export const useTenant = () => useAuth().tenant!;

export const homeFor = (role: Role) => (role === 'admin' || role === 'superadmin' ? '/admin' : role === 'teacher' ? '/teach' : '/dashboard');
