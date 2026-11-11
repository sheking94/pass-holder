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

/** Whether to save a submitted login (spec 3.2); `logins` are in `matchLogins` order. */
export function decideSave(username: string, password: string, logins: readonly SavedLogin[]): SaveDecision {
  if (password === "") return { kind: "none" };
  const [first, ...rest] = logins.filter((l) => normalize(l.username) === normalize(username));
  if (!first) return { kind: "create" };
  if (first.password === password || rest.some((l) => l.password === password)) return { kind: "none" };
  return { kind: "update", id: first.id };
}

/** New login for a `saveUrl` address (spec 3.3). */
export function newLogin(url: string, username: string, password: string): LoginEntry {
  const entry = emptyLogin(saveName(url));
  return { ...entry, fields: { ...entry.fields, username, password, urls: [url] } };
}

/** Copy of the login with only the password changed. */
export function withPassword(entry: LoginEntry, password: string): LoginEntry {
  return { ...entry, fields: { ...entry.fields, password } };
}
