import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { setTenantSlug } from '../../api';
import { server } from '../../test/server';
import { StopEmails } from './StopEmails';

beforeEach(() => setTenantSlug('acme'));
const show = () => render(<MemoryRouter initialEntries={['/stop-emails?token=abc.def.ghi']}><StopEmails /></MemoryRouter>);

describe('StopEmails', () => {
  it('does nothing until the person confirms (mail scanners open links), then opts out', async () => {
    let sent: unknown = null;
    server.use(http.post('/api/acme/auth', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ok: true }); }));
    show();
    expect(sent).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Stop emails/ }));
    expect(await screen.findByText(/will be able to invite this email address/)).toBeInTheDocument();
    expect(sent).toEqual({ action: 'stopEmails', data: { token: 'abc.def.ghi' } });
  });
  it('shows why an invalid link failed', async () => {
    server.use(http.post('/api/acme/auth', () => HttpResponse.json({ error: 'This link is invalid or has expired' }, { status: 400 })));
    show();
    await userEvent.click(screen.getByRole('button', { name: /Stop emails/ }));
    expect(await screen.findByText('This link is invalid or has expired')).toBeInTheDocument();
  });
});
