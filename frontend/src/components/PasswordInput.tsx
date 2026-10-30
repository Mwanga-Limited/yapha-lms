import { useId, useState } from 'react';
import { PASSWORD_RULES } from '../password';

/**
 * A new-password field with a show/hide toggle and a live checklist of the password rules.
 * Pass `confirm` to add a "repeat password" field that shows whether the two match.
 */
export function PasswordInput({ label = 'Password', value, onChange, confirm, onConfirmChange, autoFocus }: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  confirm?: string;
  onConfirmChange?: (v: string) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const started = touched || value.length > 0;
  const met = PASSWORD_RULES.filter((r) => r.test(value)).length;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" value={value} autoFocus={autoFocus} required
          onChange={(e) => onChange(e.target.value)} onBlur={() => setTouched(true)} aria-describedby={`${id}-rules`} />
        <button type="button" className="pw-toggle" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="pw-meter" aria-hidden><span style={{ width: `${(met / PASSWORD_RULES.length) * 100}%` }} className={met === PASSWORD_RULES.length ? 'full' : ''} /></div>
      <ul id={`${id}-rules`} className="pw-rules" aria-live="polite">
        <li className="pw-rules-title">Your password must have:</li>
        {PASSWORD_RULES.map((r) => {
          const ok = r.test(value);
          return (
            <li key={r.id} className={ok ? 'ok' : started ? 'missing' : ''}>
              <span className="pw-mark" aria-hidden>{ok ? '✓' : started ? '✕' : '•'}</span>
              {r.label}<span className="sr-only">{ok ? ' (done)' : ' (still needed)'}</span>
            </li>
          );
        })}
      </ul>
      {confirm !== undefined && onConfirmChange && (
        <div className="field pw-confirm">
          <label htmlFor={`${id}-c`}>Repeat password</label>
          <input id={`${id}-c`} type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} required
            onChange={(e) => onConfirmChange(e.target.value)} />
          {confirm.length > 0 && (confirm === value
            ? <small className="ok-text">Passwords match</small>
            : <small className="field-error">Passwords don't match yet</small>)}
        </div>
      )}
    </div>
  );
}
