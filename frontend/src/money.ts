// Prices come from the server in the currency's smallest unit (kobo, pesewas, cents), as Paystack uses.
export const fromMinor = (minor: number) => minor / 100;
export const toMajor = fromMinor;
export const toMinor = (amount: number) => Math.round(amount * 100);

/** ₦15,000. Every course is paid; for a course with no price yet (0), pass unset: 'Not set' to show that instead of ₦0. */
export function formatMoney(minor: number, currency = 'NGN', { unset }: { unset?: string } = {}): string {
  if (unset && minor <= 0) return unset;
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(fromMinor(minor));
}
