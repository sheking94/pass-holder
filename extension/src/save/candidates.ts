import { autofill, save } from "@passholder/core";
import { LOCKED } from "../autofill/fill-tab.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import type { VaultStore } from "../vault-store.ts";
import type {
  SaveAnswerMessage, SaveCandidateMessage, SaveInfoMessage, SavePendingMessage, SavePromptInfo, ToWatchMessage,
} from "./messages.ts";

export const SAVE_TTL_MS = 120_000;
export const SAVED_HIDE_MS = 2000;
export const SAVE_ALARM_PREFIX = "save-expire:";

export interface Sender { id?: string; url?: string; tab?: { id?: number; url?: string } }

export interface SaveDeps {
  store(): VaultStore;
  /** chrome.storage.session: the candidates (with the password) live only here. */
  session: KeyValueStore;
  /** chrome.storage.local: only the never list. */
  local: KeyValueStore;
  selfId: string;
  sendToTab(tabId: number, m: ToWatchMessage): Promise<void>;
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
}

type Candidates = Record<string, Candidate>;
type Answer = { ok: true } | { ok: false; error: string };

const GONE = "Pytanie o zapis wygasło";
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

  private async remove(tabId: number): Promise<void> {
    const all = await this.all();
    if (!(String(tabId) in all)) return;
    delete all[String(tabId)];
    await this.write(all);
    await this.deps.alarms.clear(alarmName(tabId)).catch(() => false);
  }

  /** The tab's live candidate; an expired one is removed and treated as absent. */
  private async forTab(tabId: number): Promise<Candidate | undefined> {
    const c = (await this.all())[String(tabId)];
    if (!c) return undefined;
    if (this.deps.now() - c.at >= SAVE_TTL_MS) {
      await this.remove(tabId);
      return undefined;
    }
    return c;
  }

  private async byId(id: string): Promise<Candidate | undefined> {
    const found = Object.values(await this.all()).find((c) => c.id === id);
    return found && (await this.forTab(found.tabId));
  }

  /** What to do with the candidate; null when the vault is locked. */
  private async decide(store: VaultStore, c: Candidate, touch: boolean): Promise<save.SaveDecision | null> {
    if (!(await store.resume({ touch }))) return null;
    const logins = autofill
      .matchLogins(c.url, store.listEntries("login"), (e) => ({ name: e.data.name, urls: e.data.type === "login" ? e.data.fields.urls : [] }))
      .flatMap((e) => (e.data.type === "login" ? [{ id: e.id, username: e.data.fields.username, password: e.data.fields.password }] : []));
    return save.decideSave(c.username, c.password, logins);
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
    const c: Candidate = {
      id: this.deps.newId(), tabId: from.tabId, url, username: m.username, password: m.password, at: now,
      formSignature: `${from.frame.origin}|${m.formSignature}`,
    };
    if ((await this.decide(this.deps.store(), c, false))?.kind === "none") return;

    const all = await this.all();
    all[String(from.tabId)] = c;
    await this.write(all);
    await this.deps.alarms.create(alarmName(from.tabId), { when: now + SAVE_TTL_MS });
    await this.deps.sendToTab(from.tabId, { target: "save-watch", type: "save-show", candidateId: c.id });
  }

  onPending(m: SavePendingMessage, s: Sender): Promise<{ candidateId?: string }> {
    return this.serial(() => this.doPending(m, s));
  }

  private async doPending(m: SavePendingMessage, s: Sender): Promise<{ candidateId?: string }> {
    const from = this.fromScript(s);
    if (!from || webUrl(s.tab?.url)?.origin !== from.frame.origin) return {};
    const c = await this.forTab(from.tabId);
    if (!c) return {};
    if (from.frame.origin === candidateOrigin(c) && m.emptyLoginForms.some((sig) => `${from.frame.origin}|${sig}` === c.formSignature)) {
      return {};
    }
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
      await this.remove(c.tabId);
      return undefined;
    }
    const base = { id: c.id, host: save.saveName(c.url), username: c.username };
    if (decision === null) return { ...base, decision: null, locked: true };
    return { ...base, decision: decision.kind, locked: false };
  }

  answer(m: SaveAnswerMessage, s: Sender): Promise<Answer> {
    return this.serial(() => this.doAnswer(m, s));
  }

  private async doAnswer(m: SaveAnswerMessage, s: Sender): Promise<Answer> {
    if (!this.fromExtensionPage(s)) return { ok: false, error: NOT_ALLOWED };
    const c = await this.byId(m.candidateId);
    if (!c) return { ok: false, error: GONE };

    if (m.answer === "later" || m.answer === "never") {
      if (m.answer === "never") {
        const never = await neverList(this.deps.local);
        const host = save.saveName(c.url);
        if (!never.includes(host)) await this.deps.local.set(STORAGE_KEYS.saveNever, [...never, host]);
      }
      await this.remove(c.tabId);
      await this.deps.sendToTab(c.tabId, { target: "save-watch", type: "save-hide" });
      return { ok: true };
    }

    const store = this.deps.store();
    const decision = await this.decide(store, c, true);
    if (decision === null) return { ok: false, error: LOCKED };
    // Remove first: whatever happens next, the candidate cannot be saved twice.
    await this.remove(c.tabId);
    if (decision.kind === "update") {
      const entry = store.getEntry(decision.id);
      if (entry?.data.type !== "login") {
        await this.deps.sendToTab(c.tabId, { target: "save-watch", type: "save-hide" });
        return { ok: false, error: GONE };
      }
      await store.putEntry(decision.id, save.withPassword(entry.data, c.password));
    } else if (decision.kind === "create") {
      await store.putEntry(this.deps.newId(), save.newLogin(c.url, c.username, c.password));
    }
    if (decision.kind !== "none") {
      // The panel shows "Zapisano" by itself; the tab hides it a moment later.
      this.deps.later(SAVED_HIDE_MS, () => {
        void this.deps.sendToTab(c.tabId, { target: "save-watch", type: "save-hide" }).catch(() => undefined);
      });
    } else {
      await this.deps.sendToTab(c.tabId, { target: "save-watch", type: "save-hide" });
    }
    return { ok: true };
  }

  onAlarm(name: string): Promise<void> {
    return this.serial(() => this.doAlarm(name));
  }

  private async doAlarm(name: string): Promise<void> {
    if (!name.startsWith(SAVE_ALARM_PREFIX)) return;
    const tabId = Number(name.slice(SAVE_ALARM_PREFIX.length));
    if (Number.isInteger(tabId)) await this.remove(tabId);
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.serial(() => this.remove(tabId));
  }
}
