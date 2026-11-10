/** Prices are kept in the currency's smallest unit (kobo, pesewas, cents), as Paystack expects. */
export const toMinor = (amount) => Math.round(Number(amount) * 100);
export const fromMinor = (minor) => Number(minor) / 100;
export const formatMoney = (minor, currency) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(fromMinor(minor));
