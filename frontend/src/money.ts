// Prices come from the server in the currency's smallest unit (kobo, pesewas, cents), as Paystack uses.
export const fromMinor = (minor: number) => minor / 100;
export const toMajor = fromMinor;
export const toMinor = (amount: number) => Math.round(amount * 100);

/** Pricing is optional: 0 = free. A price, when set, is at least MIN_PRICE (the backend checks this too). */
export const MIN_PRICE = 1000;

/** What's wrong with a price typed into a form, or null. Empty = a free course. */
export function priceProblem(value: string, currency = 'NGN'): string | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 'Enter an amount, or leave it empty for a free course.';
  if (n > 0 && n < MIN_PRICE) return `The minimum price is ${formatMoney(MIN_PRICE * 100, currency)}. Leave it empty for a free course.`;
  return null;
}

/** A form's price as a number for the API: empty = 0 (free). */
export const priceInput = (value: string) => (value.trim() === '' ? 0 : Number(value));

/** ₦15,000, or "Free" for a course without a price. */
export const priceLabel = (minor: number, currency = 'NGN') => (minor > 0 ? formatMoney(minor, currency) : 'Free');

/** ₦15,000. For an amount that may be 0, pass unset: 'Not set' to show that instead of ₦0. */
export function formatMoney(minor: number, currency = 'NGN', { unset }: { unset?: string } = {}): string {
  if (unset && minor <= 0) return unset;
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(fromMinor(minor));
}
