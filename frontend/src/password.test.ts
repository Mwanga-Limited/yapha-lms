import { describe, expect, it } from 'vitest';
import { PASSWORD_RULES, passwordOk } from './password';

describe('password rules', () => {
  it('accepts a strong password and names what is missing from a weak one', () => {
    expect(passwordOk('Str0ng!pass')).toBe(true);
    const missing = (p: string) => PASSWORD_RULES.filter((r) => !r.test(p)).map((r) => r.id);
    expect(missing('password')).toEqual(['upper', 'num', 'special']);
    expect(missing('Ab1!')).toEqual(['len']);
  });
});
