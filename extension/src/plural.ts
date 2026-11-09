/** The Polish noun form for a count: 1 → one, 2–4 (not 12–14) → few, otherwise many. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

/** "1 wpis", "3 wpisy", "5 wpisów". */
export function entriesNoun(n: number): string {
  return `${n} ${plural(n, "wpis", "wpisy", "wpisów")}`;
}
