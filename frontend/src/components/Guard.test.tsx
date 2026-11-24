import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Guard } from './Guard';

const auth = vi.hoisted(() => ({ value: { user: null as null | { role: string }, loading: false } }));
vi.mock('../auth', () => ({ useAuth: () => auth.value }));

const renderGuard = (roles?: ('student' | 'teacher' | 'admin')[]) => render(
  <MemoryRouter initialEntries={['/secret']}>
    <Routes>
      <Route path="/login" element={<p>login page</p>} />
      <Route path="/secret" element={<Guard roles={roles}><p>secret page</p></Guard>} />
    </Routes>
  </MemoryRouter>,
);

describe('Guard', () => {
  it('sends signed-out visitors to the login page', () => {
    auth.value = { user: null, loading: false };
    renderGuard();
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
  it('lets the right role in and keeps the wrong one out', () => {
    auth.value = { user: { role: 'student' }, loading: false };
    renderGuard(['student']);
    expect(screen.getByText('secret page')).toBeInTheDocument();
    renderGuard(['admin']);
    expect(screen.getByText(/isn't available to your account/)).toBeInTheDocument();
  });
  it('treats a platform super admin as the Admin of an organisation', () => {
    auth.value = { user: { role: 'superadmin' }, loading: false };
    renderGuard(['admin']);
    expect(screen.getByText('secret page')).toBeInTheDocument();
  });
});
