// Password rules shown to users while they type. Must match PASSWORD_RULES in backend/src/lib/actions.js.
export const PASSWORD_RULES: { id: string; label: string; test: (p: string) => boolean }[] = [
  { id: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter (A–Z)', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter (a–z)', test: (p) => /[a-z]/.test(p) },
  { id: 'num', label: 'A number (0–9)', test: (p) => /\d/.test(p) },
  { id: 'special', label: 'A special character (e.g. ! @ # $ %)', test: (p) => /[^A-Za-z0-9]/.test(p) },
];
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.test(p));
