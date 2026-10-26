import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, type Notification } from '../api';
import { useAuth } from '../auth';
import { timeAgo, useAction } from '../ui';

function Bell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);

  const load = () => api<{ items: Notification[]; unread: number }>('account', 'notifications', { limit: 8 })
    .then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => {});

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const openItem = async (n: Notification) => {
    setOpen(false);
    if (!n.read_at) await api('account', 'markNotificationsRead', { ids: [n.id] }).catch(() => {});
    void load();
    if (n.link) nav(n.link);
  };

  return (
    <div className="bell" ref={box}>
      <button className="icon-btn bell-btn" aria-label={`Notifications, ${unread} unread`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="menu">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link-btn" onClick={async () => { await api('account', 'markNotificationsRead'); void load(); }}>Mark all read</button>}
          </div>
          {items.length === 0 && <p className="muted bell-empty">Nothing yet. Updates about your courses appear here.</p>}
          {items.map((n) => (
            <button key={n.id} className={`bell-item ${n.read_at ? '' : 'unread'}`} onClick={() => openItem(n)} role="menuitem">
              <span className="bell-title">{n.title}</span>
              {n.body && <span className="bell-body">{n.body}</span>}
              <span className="bell-time">{timeAgo(n.created_at)}</span>
            </button>
          ))}
          <Link to="/notifications" className="bell-all" onClick={() => setOpen(false)}>See all notifications</Link>
        </div>
      )}
    </div>
  );
}

function VerifyBanner() {
  const { user } = useAuth();
  const { busy, run } = useAction();
  if (!user || user.emailVerified) return null;
  return (
    <div className="banner">
      <div className="wrap banner-inner">
        <span>Check your inbox to verify <strong>{user.email}</strong>. You need a verified email to enrol or submit a course.</span>
        <button className="link-btn" disabled={busy} onClick={() => run(() => api('auth', 'resendVerification'), 'Verification email sent')}>Send it again</button>
      </div>
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);

  const links: { to: string; label: string; end?: boolean }[] = [{ to: '/', label: 'Courses', end: true }];
  if (user?.role === 'student') links.push({ to: '/dashboard', label: 'My learning' });
  if (user?.role === 'teacher') links.push({ to: '/teach', label: 'My courses' });
  if (user?.role === 'admin') links.push({ to: '/teach', label: 'My courses' }, { to: '/admin', label: 'Admin' });

  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <Link to="/" className="brand" aria-label="Learn home">
            <span className="brand-mark" aria-hidden />Learn
          </Link>
          <button className="icon-btn menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
          <nav className={`mainnav ${menu ? 'open' : ''}`} aria-label="Main">
            {links.map((l) => <NavLink key={l.to + l.label} to={l.to} end={l.end}>{l.label}</NavLink>)}
            {!user && <NavLink to="/verify">Verify a certificate</NavLink>}
            {!user && <NavLink to="/login" className="nav-cta-ghost">Sign in</NavLink>}
            {!user && <NavLink to="/register" className="nav-cta">Create account</NavLink>}
            {user && (
              <div className="nav-user">
                <NavLink to="/profile" className="avatar-link" title="Profile">
                  {user.photoUrl ? <img src={user.photoUrl} alt="" className="avatar" /> : <span className="avatar avatar-initial">{user.name.charAt(0).toUpperCase()}</span>}
                  <span className="nav-name">{user.name.split(' ')[0]}</span>
                </NavLink>
                <button className="link-btn" onClick={async () => { await logout(); nav('/'); }}>Sign out</button>
              </div>
            )}
          </nav>
          {user && <Bell />}
        </div>
      </header>
      <VerifyBanner />
      <main id="main" className="wrap main">
        <Outlet />
      </main>
      <footer className="footer">
        <div className="wrap">Learn · courses, quizzes and certificates you can verify. <Link to="/verify">Verify a certificate</Link></div>
      </footer>
    </>
  );
}