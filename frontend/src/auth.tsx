import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Role, type User } from './api';

interface AuthState {
  user: User | null;
  loading: boolean;
  googleClientId: string | null;
  setUser: (u: User | null) => void;
  refresh: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User | null; googleClientId: string | null }>('auth', 'me');
      setUser(r.user);
      setGoogleClientId(r.googleClientId);
      return r.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api('auth', 'logout').catch(() => {});
    setUser(null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, googleClientId, setUser, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const homeFor = (role: Role) => (role === 'admin' ? '/admin' : role === 'teacher' ? '/teach' : '/dashboard');
