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
export function applyBranding(accent: string | undefined) {
  const root = document.documentElement;
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) { root.style.removeProperty('--hl'); root.style.removeProperty('--hl-soft'); return; }
  const n = parseInt(accent.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const mix = (c: number) => Math.round(c + (255 - c) * 0.72);
  root.style.setProperty('--hl', accent);
  root.style.setProperty('--hl-soft', `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`);
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
    applyBranding(t.branding.accentColor);
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
