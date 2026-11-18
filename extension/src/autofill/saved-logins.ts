import { matchLogins, type MatchOptions } from "@passholder/core/autofill";
import type { StoredEntry } from "../vault-store.ts";

/**
 * The saved logins for this page address, best first (the popup's matches, the fill shortcut, the fill check
 * and the save question all ask the same way).
 */
export function matchSavedLogins(
  pageUrl: string,
  entries: readonly StoredEntry[],
  options: MatchOptions = {},
): StoredEntry[] {
  return matchLogins(
    pageUrl,
    entries,
    (e) => ({ name: e.data.name, urls: e.data.type === "login" ? e.data.fields.urls : [] }),
    options,
  );
}
