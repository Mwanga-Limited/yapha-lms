import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { useAuth } from '../auth';
import { Empty, Loading } from '../ui';

/** Protected route: signed-in users, optionally limited to roles. */
export function Guard({ roles, personal, children }: { roles?: Role[]; personal?: boolean; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  // Personal pages (profile, notifications, teaching) need an account in this organisation.
  if (personal && user.role === 'superadmin') {
    return <Empty title="You're visiting as the platform super admin">You have no personal account in this organisation. Use the Admin pages, or go back to the <a href="/platform">platform console</a>.</Empty>;
  }
  // A platform super admin visiting an organisation acts as its Admin.
  const role = user.role === 'superadmin' ? 'admin' : user.role;
  if (roles && !roles.includes(role)) {
    return <Empty title="This page isn't available to your account">You are signed in as {user.role === 'superadmin' ? 'the platform super admin' : `a ${user.role}`}.</Empty>;
  }
  return <>{children}</>;
}
