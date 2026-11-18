/** Sentences shared by the views that sync: the list, the pairing and the phone's addresses. */

/** One sentence about addresses a sync skipped because Chrome does not allow them yet; "" when none. */
export function skippedNote(skipped: readonly string[]): string {
  if (skipped.length === 0) return "";
  return ` Pominięto adresy bez zgody Chrome: ${skipped.join(", ")}. Zgodę dasz w „Adresy telefonu” (Zapisz).`;
}
