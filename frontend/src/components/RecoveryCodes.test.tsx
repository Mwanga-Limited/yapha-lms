import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryCodes } from './RecoveryCodes';

describe('RecoveryCodes', () => {
  it('shows every code and only lets the person continue after confirming they saved them', async () => {
    const done = vi.fn();
    render(<RecoveryCodes codes={['AAAAA-BBBBB', 'CCCCC-DDDDD']} onDone={done} />);
    expect(screen.getByText('AAAAA-BBBBB')).toBeInTheDocument();
    expect(screen.getByText('CCCCC-DDDDD')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Done' });
    expect(btn).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/I have saved these codes/));
    await userEvent.click(btn);
    expect(done).toHaveBeenCalledOnce();
  });
});
