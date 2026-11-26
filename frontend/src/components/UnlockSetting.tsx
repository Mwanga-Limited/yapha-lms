import { useState } from 'react';

/** The longest delay the server accepts (a year, in hours). */
export const MAX_UNLOCK_HOURS = 365 * 24;

/** "2 days", "36 hours", "1 hour". */
export function describeDelay(hours: number): string {
  if (hours % 24 === 0) { const d = hours / 24; return `${d} ${d === 1 ? 'day' : 'days'}`; }
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** How a course unlocks, in one sentence, for teachers, Admins and learners. */
export function describeUnlock(afterHours: number | null | undefined): string {
  return afterHours
    ? `The course opens ${describeDelay(afterHours)} after a learner enrols. Then each section opens when the one before it is complete.`
    : 'The course opens as soon as a learner enrols. Each section opens when the one before it is complete.';
}

type Unit = 'hours' | 'days';
const split = (h: number | null): { amount: string; unit: Unit } =>
  !h ? { amount: '', unit: 'days' } : h % 24 === 0 ? { amount: String(h / 24), unit: 'days' } : { amount: String(h), unit: 'hours' };

/** What's wrong with a typed delay, or null. */
export function delayProblem(amount: string, unit: Unit): string | null {
  const n = Number(amount);
  if (amount.trim() === '' || !Number.isInteger(n) || n < 1) return `Enter a whole number of ${unit} (1 or more).`;
  if ((unit === 'days' ? n * 24 : n) > MAX_UNLOCK_HOURS) return 'The delay must be under a year.';
  return null;
}

/**
 * Optional time-based unlocking: "as soon as the learner enrols" or "after a delay" of so many hours or days.
 * Calls onChange with the delay in hours (null = no delay) whenever the choice is valid; invalid input is shown, not sent.
 */
export function UnlockDelayField({ value, onChange, disabled }: { value: number | null; onChange: (afterHours: number | null) => void; disabled?: boolean }) {
  const [delayed, setDelayed] = useState(!!value);
  const [{ amount, unit }, setParts] = useState(() => split(value));
  const problem = delayed ? delayProblem(amount, unit) : null;
  const emit = (on: boolean, a: string, u: Unit) => {
    if (!on) return onChange(null);
    if (!delayProblem(a, u)) onChange(u === 'days' ? Number(a) * 24 : Number(a));
  };
  return (
    <fieldset className="unlock-field plain" disabled={disabled}>
      <legend>When the course opens</legend>
      <label className="radio-row">
        <input type="radio" name="unlock-when" checked={!delayed} onChange={() => { setDelayed(false); emit(false, amount, unit); }} />
        As soon as the learner enrols
      </label>
      <label className="radio-row">
        <input type="radio" name="unlock-when" checked={delayed} onChange={() => {
          const a = amount || '2';
          setDelayed(true); setParts({ amount: a, unit }); emit(true, a, unit);
        }} />
        After a delay
      </label>
      {delayed && (
        <div className="unlock-delay">
          <input type="number" aria-label="Delay" min={1} step={1} inputMode="numeric" value={amount} aria-invalid={!!problem || undefined}
            onChange={(e) => { setParts({ amount: e.target.value, unit }); emit(true, e.target.value, unit); }} />
          <select aria-label="Delay unit" value={unit} onChange={(e) => { const u = e.target.value as Unit; setParts({ amount, unit: u }); emit(true, amount, u); }}>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
          <span className="muted small">after enrolling</span>
        </div>
      )}
      {problem && <small className="field-error">{problem}</small>}
    </fieldset>
  );
}
