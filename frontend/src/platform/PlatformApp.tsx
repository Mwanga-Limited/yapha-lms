import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { platformApi, type User } from '../api';
import { Empty, Loading, setSiteName } from '../ui';
import { PlatformAccount } from './Account';
import { PlatformAudit } from './Audit';
import { PlatformLogin } from './Login';
import { OrganisationDetail } from './OrganisationDetail';
import { Organisations } from './Organisations';
import { PlatformOverview } from './Overview';
import { PlatformUsers } from './Users';

interface PlatformAuth { user: User | null; loading: boolean; setUser: (u: User | null) => void; logout: () => Promise<void> }
const Ctx = createContext<PlatformAuth | null>(null);
export const usePlatformAuth = () => useContext(Ctx)!;

function PlatformAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setSiteName('Platform console');
    platformApi<{ user: User | null }>('me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  const logout = useCallback(async () => { await platformApi('logout').catch(() => {}); setUser(null); }, []);
  return <Ctx.Provider value={{ user, loading, setUser, logout }}>{children}</Ctx.Provider>;
}

function RequireSuper({ children }: { children: ReactNode }) {
  const { user, loading } = usePlatformAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function PlatformLayout() {
  const { user, logout } = usePlatformAuth();
  const nav = useNavigate();
  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <header className="topbar topbar-platform">
        <div className="wrap topbar-inner">
          <Link to="/" className="brand"><span className="brand-mark" aria-hidden /><span className="brand-name">Platform console</span></Link>
          {user && (
            <nav className="mainnav platform-nav" aria-label="Platform">
              <NavLink to="/" end>Overview</NavLink>
              <NavLink to="/organisations">Organisations</NavLink>
              <NavLink to="/users">People</NavLink>
              <NavLink to="/audit">Audit log</NavLink>
              <div className="nav-user">
                <NavLink to="/account" className="avatar-link"><span className="avatar avatar-initial">{user.name.charAt(0)}</span><span className="nav-name">{user.name.split(' ')[0]}</span></NavLink>
                <button className="link-btn" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
              </div>
            </nav>
          )}
        </div>
      </header>
      <main id="main" className="wrap main"><Outlet /></main>
      <footer className="footer"><div className="wrap">Super admin view of every organisation. Organisations never see each other.</div></footer>
    </>
  );
}

export function PlatformApp() {
  return (
    <PlatformAuthProvider>
      <Routes>
        <Route element={<PlatformLayout />}>
          <Route path="login" element={<PlatformLogin />} />
          <Route index element={<RequireSuper><PlatformOverview /></RequireSuper>} />
          <Route path="organisations" element={<RequireSuper><Organisations /></RequireSuper>} />
          <Route path="organisations/:id" element={<RequireSuper><OrganisationDetail /></RequireSuper>} />
          <Route path="users" element={<RequireSuper><PlatformUsers /></RequireSuper>} />
          <Route path="audit" element={<RequireSuper><PlatformAudit /></RequireSuper>} />
          <Route path="account" element={<RequireSuper><PlatformAccount /></RequireSuper>} />
          <Route path="*" element={<Empty title="This page does not exist"><Link to="/">Back to the overview</Link></Empty>} />
        </Route>
      </Routes>
    </PlatformAuthProvider>
  );
}
