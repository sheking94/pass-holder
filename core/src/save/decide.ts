import { emptyLogin, type EntryContentV3 } from "../p2p/entry.ts";
import { saveName } from "./url.ts";

export interface SavedLogin {
  id: string;
  username: string;
  password: string;
}

export type SaveDecision = { kind: "none" } | { kind: "create" } | { kind: "update"; id: string };

type LoginEntry = EntryContentV3 & { type: "login" };

const normalize = (username: string) => username.trim().toLowerCase();

/**
 * Whether to save a submitted login (spec 3.2). `logins` are the exact-host matches in `matchLogins` order: only they
 * can be updated (review V3-S2). `related` (subdomain matches) only stop the question when the same login and
 * password are already saved there.
 */
export function decideSave(
  username: string,
  password: string,
  logins: readonly SavedLogin[],
  related: readonly SavedLogin[] = [],
): SaveDecision {
  if (password === "") return { kind: "none" };
  const same = (l: SavedLogin) => normalize(l.username) === normalize(username);
  const sameLogins = logins.filter(same);
  if ([...sameLogins, ...related.filter(same)].some((l) => l.password === password))
    return { kind: "none" };
  const first = sameLogins[0];
  return first ? { kind: "update", id: first.id } : { kind: "create" };
}

/** New login for a `saveUrl` address (spec 3.3). */
export function newLogin(url: string, username: string, password: string): LoginEntry {
  const entry = emptyLogin(saveName(url));
  return { ...entry, fields: { ...entry.fields, username, password, urls: [url] } };
}

/** Label of the hidden custom field that keeps the password a save prompt replaced (review V3-S1). */
export const PREVIOUS_PASSWORD_LABEL = "Poprzednie hasło";

/**
 * Copy of the login with the new password; the old one goes to the hidden custom field „Poprzednie hasło”
 * (only the latest: an earlier such field is replaced), so a wrong „Zapisz” loses nothing.
 */
export function withPassword(entry: LoginEntry, password: string): LoginEntry {
  const old = entry.fields.password;
  const custom =
    old === "" || old === password
      ? entry.custom
      : [
          ...entry.custom.filter((c) => c.label !== PREVIOUS_PASSWORD_LABEL),
          { label: PREVIOUS_PASSWORD_LABEL, value: old, hidden: true },
        ];
  return { ...entry, custom, fields: { ...entry.fields, password } };
}
