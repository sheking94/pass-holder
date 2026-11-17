// Formats of entry fields, shared by the form checks, autofill and import/export.
// No imports: the autofill content script bundles this file.

/** Card expiry "MM/RR"; groups: month, two-digit year. */
export const CARD_EXPIRY = /^(0[1-9]|1[0-2])\/(\d{2})$/;

/** True for a real calendar date written as RRRR-MM-DD (years 0000–9999). */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCFullYear(y); // years 0000-0099 map to 1900+ in the constructor
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
