import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { useAuth } from '../auth';
import { Empty, Loading } from '../ui';

/** Protected route: signed-in users, optionally limited to roles. */
export function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (roles && !roles.includes(user.role)) {
    return <Empty title="This page isn't available to your account">You are signed in as a {user.role}.</Empty>;
  }
  return <>{children}</>;
}
