import { autofill, save } from "@passholder/core";
import { LOCKED } from "../autofill/fill-tab.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import type { VaultStore } from "../vault-store.ts";
import type {
  SaveAnswerMessage, SaveCandidateMessage, SaveInfoMessage, SavePendingMessage, SavePreviewMessage, SavePreviewResponse, SavePromptInfo,
  SaveUnlockMessage,
} from "./messages.ts";

export const SAVE_TTL_MS = 120_000;
export const SAVED_HIDE_MS = 2000;
export const SAVE_ALARM_PREFIX = "save-expire:";

export interface Sender { id?: string; url?: string; tab?: { id?: number; url?: string } }

/** Where the question is shown: PromptWindows (its own window and a badge) in the extension, a fake in tests. */
export interface SavePrompt {
  show(tabId: number, candidateId: string): Promise<void>;
  /** Window closed, badge cleared: no question for the tab any more. */
  hide(tabId: number): Promise<void>;
  /** Window closed, badge kept: the question still waits in the popup. */
  closeWindow(tabId: number): Promise<void>;
  /** Badge only (it may be reset when the tab navigates). */
  badge(tabId: number): Promise<void>;
}

export interface SaveDeps {
  store(): VaultStore;
  /** chrome.storage.session: the candidates (with the password) live only here. */
  session: KeyValueStore;
  /** chrome.storage.local: only the never list. */
  local: KeyValueStore;
  selfId: string;
  prompt: SavePrompt;
  alarms: { create(name: string, info: { when: number }): Promise<void>; clear(name: string): Promise<boolean> };
  now(): number;
  newId(): string;
  later(ms: number, fn: () => void): void;
}

interface Candidate {
  id: string;
  tabId: number;
  /** saveUrl of the page that sent it */
  url: string;
  username: string;
  password: string;
  at: number;
  /** origin + "|" + the form signature from the script */
  formSignature: string;
  /** The user closed the question window: keep only the badge, do not open it again on the next page. */
  dismissed?: boolean;
}

type Candidates = Record<string, Candidate>;
type SavedLogin = save.SavedLogin & { entryName: string };
type Answer = { ok: true } | { ok: false; error: string };

const GONE = "Pytanie o zapis wygasło";
const EMPTY_PASSWORD = "Podaj hasło";
const ALREADY_SAVED = "Ten login jest już zapisany w PassHolder";
const NOT_ALLOWED = "Niedozwolony nadawca";

export async function neverList(local: KeyValueStore): Promise<string[]> {
  return (await local.get<string[]>(STORAGE_KEYS.saveNever)) ?? [];
}

export async function removeFromNever(local: KeyValueStore, host: string): Promise<void> {
  const rest = (await neverList(local)).filter((h) => h !== host);
  if (rest.length > 0) await local.set(STORAGE_KEYS.saveNever, rest);
  else await local.remove(STORAGE_KEYS.saveNever);
}

function parseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function webUrl(raw: string | undefined): URL | undefined {
  const url = parseUrl(raw);
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
}

/** The origin a candidate was captured on (the signature is `origin|...`; an origin has no "|"). */
const candidateOrigin = (c: Candidate) => c.formSignature.split("|")[0]!;

const alarmName = (tabId: number) => `${SAVE_ALARM_PREFIX}${tabId}`;

export class SaveCandidates {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SaveDeps) {}

  /** Runs operations one after another: they read and write the same storage key. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async all(): Promise<Candidates> {
    return (await this.deps.session.get<Candidates>(STORAGE_KEYS.saveCandidates)) ?? {};
  }

  private async write(all: Candidates): Promise<void> {
    if (Object.keys(all).length > 0) await this.deps.session.set(STORAGE_KEYS.saveCandidates, all);
    else await this.deps.session.remove(STORAGE_KEYS.saveCandidates);
  }

  /** Removes the tab's candidate; true when there was one. */
  private async remove(tabId: number): Promise<boolean> {
    const all = await this.all();
    if (!(String(tabId) in all)) return false;
    delete all[String(tabId)];
    await this.write(all);
    await this.deps.alarms.clear(alarmName(tabId)).catch(() => false);
    return true;
  }

  private hide(tabId: number): Promise<void> {
    return this.deps.prompt.hide(tabId);
  }

  /** Removes the candidate for any reason but a save or a closed tab: its question must not stay open. */
  private async drop(tabId: number): Promise<void> {
    if (await this.remove(tabId)) await this.hide(tabId);
  }

  /** The tab's live candidate; an expired one is removed and treated as absent. */
  private async forTab(tabId: number): Promise<Candidate | undefined> {
    const c = (await this.all())[String(tabId)];
    if (!c) return undefined;
    if (this.deps.now() - c.at >= SAVE_TTL_MS) {
      await this.drop(tabId);
      return undefined;
    }
    return c;
  }

  private async byId(id: string): Promise<Candidate | undefined> {
    const found = Object.values(await this.all()).find((c) => c.id === id);
    return found && (await this.forTab(found.tabId));
  }

  /**
   * Saved logins for the candidate's address; null when the vault is locked. Only `exact` (same host) may be updated
   * (review V3-S2); `related` (subdomain matches) only tell that the login is saved already.
   */
  private async matching(store: VaultStore, c: Candidate, touch: boolean): Promise<{ exact: SavedLogin[]; related: SavedLogin[] } | null> {
    if (!(await store.resume({ touch }))) return null;
    const entries = store.listEntries("login");
    const candidate = (e: (typeof entries)[number]) => ({ name: e.data.name, urls: e.data.type === "login" ? e.data.fields.urls : [] });
    const exactIds = new Set(autofill.matchLogins(c.url, entries, candidate, { exactOnly: true }).map((e) => e.id));
    const all = autofill.matchLogins(c.url, entries, candidate).flatMap((e) => (e.data.type === "login"
      ? [{ id: e.id, entryName: e.data.name, username: e.data.fields.username, password: e.data.fields.password }]
      : []));
    return { exact: all.filter((l) => exactIds.has(l.id)), related: all.filter((l) => !exactIds.has(l.id)) };
  }

  /** What to do with the given login and password; null when the vault is locked. */
  private async decideFor(store: VaultStore, c: Candidate, username: string, password: string, touch: boolean): Promise<save.SaveDecision | null> {
    const logins = await this.matching(store, c, touch);
    return logins && save.decideSave(username, password, logins.exact, logins.related);
  }

  /** What to do with the candidate; null when the vault is locked. */
  private decide(store: VaultStore, c: Candidate, touch: boolean): Promise<save.SaveDecision | null> {
    return this.decideFor(store, c, c.username, c.password, touch);
  }

  private fromScript(s: Sender): { tabId: number; frame: URL } | undefined {
    const frame = webUrl(s.url);
    if (s.id !== this.deps.selfId || s.tab?.id === undefined || !frame) return undefined;
    return { tabId: s.tab.id, frame };
  }

  private fromExtensionPage(s: Sender): boolean {
    return s.id === this.deps.selfId && parseUrl(s.url)?.protocol === "chrome-extension:";
  }

  onCandidate(m: SaveCandidateMessage, s: Sender): Promise<void> {
    return this.serial(() => this.doCandidate(m, s));
  }

  private async doCandidate(m: SaveCandidateMessage, s: Sender): Promise<void> {
    const from = this.fromScript(s);
    if (!from) return;
    const tab = webUrl(s.tab?.url);
    if (!tab || tab.origin !== from.frame.origin) return;
    const url = save.saveUrl(from.frame.href);
    if (url === null || m.password === "") return;
    if ((await neverList(this.deps.local)).includes(save.saveName(url))) return;

    const now = this.deps.now();
    const formSignature = `${from.frame.origin}|${m.formSignature}`;
    // One submission fires several reports (click, Enter, submit): the same login keeps its id, so the panel
    // already on the page stays valid.
    const prev = await this.forTab(from.tabId);
    const same = prev?.username === m.username && prev.password === m.password && prev.formSignature === formSignature;
    const c: Candidate = {
      id: same ? prev.id : this.deps.newId(), tabId: from.tabId, url, username: m.username, password: m.password, at: now,
      formSignature,
    };
    if ((await this.decide(this.deps.store(), c, false))?.kind === "none") return;

    const all = await this.all();
    all[String(from.tabId)] = c;
    await this.write(all);
    await this.deps.alarms.create(alarmName(from.tabId), { when: now + SAVE_TTL_MS });
    await this.deps.prompt.show(from.tabId, c.id);
  }

  onPending(m: SavePendingMessage, s: Sender): Promise<{ candidateId?: string }> {
    return this.serial(() => this.doPending(m, s));
  }

  private async doPending(m: SavePendingMessage, s: Sender): Promise<{ candidateId?: string }> {
    const from = this.fromScript(s);
    if (!from || webUrl(s.tab?.url)?.origin !== from.frame.origin) return {};
    const c = await this.forTab(from.tabId);
    if (!c) return {};
    // The same login form again, empty: the login most likely failed, so do not ask about it on this page.
    if (from.frame.origin === candidateOrigin(c) && m.emptyLoginForms.some((sig) => `${from.frame.origin}|${sig}` === c.formSignature)) {
      await this.deps.prompt.closeWindow(from.tabId);
      return {};
    }
    if (c.dismissed) {
      await this.deps.prompt.badge(from.tabId);
      return {};
    }
    await this.deps.prompt.show(from.tabId, c.id);
    return { candidateId: c.id };
  }

  info(m: SaveInfoMessage, s: Sender): Promise<SavePromptInfo | undefined> {
    return this.serial(() => this.doInfo(m, s));
  }

  private async doInfo(m: SaveInfoMessage, s: Sender): Promise<SavePromptInfo | undefined> {
    if (!this.fromExtensionPage(s)) return undefined;
    const c = m.candidateId !== undefined ? await this.byId(m.candidateId) : m.tabId !== undefined ? await this.forTab(m.tabId) : undefined;
    if (!c) return undefined;
    const decision = await this.decide(this.deps.store(), c, false);
    if (decision?.kind === "none") {
      await this.drop(c.tabId);
      return undefined;
    }
    const base = { id: c.id, host: save.saveName(c.url), username: c.username };
    if (decision === null) return { ...base, password: "", decision: null, locked: true };
    const info = { ...base, password: c.password, decision: decision.kind, locked: false };
    if (decision.kind !== "update") return info;
    return { ...info, entryName: (await this.matching(this.deps.store(), c, false))?.exact.find((l) => l.id === decision.id)?.entryName };
  }

  preview(m: SavePreviewMessage, s: Sender): Promise<SavePreviewResponse> {
    return this.serial(() => this.doPreview(m, s));
  }

  private async doPreview(m: SavePreviewMessage, s: Sender): Promise<SavePreviewResponse> {
    if (!this.fromExtensionPage(s)) return undefined;
    const c = await this.byId(m.candidateId);
    if (!c) return undefined;
    const logins = await this.matching(this.deps.store(), c, false);
    if (!logins) return undefined;
    // Without a password only the login counts (like the phone's review): update the first entry with it, else create.
    const wanted = m.username.trim().toLowerCase();
    const sameLogin = logins.exact.find((l) => l.username.trim().toLowerCase() === wanted);
    const decision =
      m.password !== "" ? save.decideSave(m.username, m.password, logins.exact, logins.related)
      : sameLogin ? { kind: "update" as const, id: sameLogin.id }
      : { kind: "create" as const };
    if (decision.kind !== "update") return { decision: decision.kind };
    return { decision: "update", entryName: logins.exact.find((l) => l.id === decision.id)?.entryName };
  }

  answer(m: SaveAnswerMessage, s: Sender): Promise<Answer> {
    return this.serial(() => this.doAnswer(m, s));
  }

  private async doAnswer(m: SaveAnswerMessage, s: Sender): Promise<Answer> {
    if (!this.fromExtensionPage(s)) return { ok: false, error: NOT_ALLOWED };
    const c = await this.byId(m.candidateId);
    // Nothing left to decline (expired or replaced; a newer candidate already has the window): the page closes itself.
    if (!c) return m.answer === "save" ? { ok: false, error: GONE } : { ok: true };

    if (m.answer === "later" || m.answer === "never") {
      if (m.answer === "never") {
        const never = await neverList(this.deps.local);
        const host = save.saveName(c.url);
        if (!never.includes(host)) await this.deps.local.set(STORAGE_KEYS.saveNever, [...never, host]);
      }
      await this.remove(c.tabId);
      await this.hide(c.tabId);
      return { ok: true };
    }

    const draft = m.draft ?? { name: "", username: c.username, password: c.password };
    if (draft.password === "") return { ok: false, error: EMPTY_PASSWORD };
    const store = this.deps.store();
    const decision = await this.decideFor(store, c, draft.username, draft.password, true);
    if (decision === null) return { ok: false, error: LOCKED };
    // Remove first: whatever happens next, the candidate cannot be saved twice.
    await this.remove(c.tabId);
    if (decision.kind === "update") {
      const entry = store.getEntry(decision.id);
      if (entry?.data.type !== "login") {
        await this.hide(c.tabId);
        return { ok: false, error: GONE };
      }
      await store.putEntry(decision.id, save.withPassword(entry.data, draft.password));
    } else if (decision.kind === "create") {
      const name = draft.name.trim() || save.saveName(c.url);
      await store.putEntry(this.deps.newId(), { ...save.newLogin(c.url, draft.username, draft.password), name });
    }
    if (decision.kind !== "none") {
      // The window shows "Zapisano" by itself; it is closed a moment later.
      this.deps.later(SAVED_HIDE_MS, () => {
        void this.hide(c.tabId).catch(() => undefined);
      });
    } else {
      await this.hide(c.tabId);
      // A draft can name a login saved meanwhile: tell the panel instead of pretending it saved.
      if (m.draft) return { ok: false, error: ALREADY_SAVED };
    }
    return { ok: true };
  }

  onAlarm(name: string): Promise<void> {
    return this.serial(() => this.doAlarm(name));
  }

  private async doAlarm(name: string): Promise<void> {
    if (!name.startsWith(SAVE_ALARM_PREFIX)) return;
    const tabId = Number(name.slice(SAVE_ALARM_PREFIX.length));
    if (Number.isInteger(tabId)) await this.drop(tabId);
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.serial(async () => {
      await this.remove(tabId);
      await this.deps.prompt.closeWindow(tabId);
    });
  }

  /** The user closed the question window of the tab: keep the candidate (badge and popup) until it expires. */
  onWindowClosed(tabId: number): Promise<void> {
    return this.serial(async () => {
      const all = await this.all();
      const c = all[String(tabId)];
      if (!c) return;
      all[String(tabId)] = { ...c, dismissed: true };
      await this.write(all);
    });
  }

  /** The tab of the candidate the question window asks to unlock for; undefined for a foreign sender or none. */
  unlockTab(m: SaveUnlockMessage, s: Sender): Promise<number | undefined> {
    return this.serial(async () => (this.fromExtensionPage(s) ? (await this.byId(m.candidateId))?.tabId : undefined));
  }
}
