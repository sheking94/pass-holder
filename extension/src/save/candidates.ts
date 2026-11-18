import type { ActionResult } from "../result.ts";
import { autofill, save } from "@passholder/core";
import { UNLOCK_AND_RETRY } from "../error-messages.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import type { VaultStore } from "../vault-store.ts";
import type {
  SaveAnswerMessage,
  SaveCandidateMessage,
  SaveDraft,
  SaveInfoMessage,
  SavePendingMessage,
  SavePreviewMessage,
  SavePreviewResponse,
  SavePromptInfo,
  SaveUnlockMessage,
} from "./messages.ts";

export const SAVE_TTL_MS = 120_000;
export const SAVED_HIDE_MS = 2000;
export const SAVE_ALARM_PREFIX = "save-expire:";

export interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number; url?: string };
}

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
  alarms: {
    create(name: string, info: { when: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
  };
  now(): number;
  newId(): string;
  later(ms: number, fn: () => void): void;
}

/** The login form a candidate was captured from: the frame's origin and the form signature from the script. */
interface FormKey {
  origin: string;
  signature: string;
}

interface Candidate {
  id: string;
  tabId: number;
  /** saveUrl of the page that sent it */
  url: string;
  username: string;
  password: string;
  at: number;
  form: FormKey;
  /** The user closed the question window: keep only the badge, do not open it again on the next page. */
  dismissed?: boolean;
}

type Candidates = Record<string, Candidate>;
type SavedLogin = save.SavedLogin & { entryName: string };

/** Saved logins for a candidate's address. Only `exact` (same host) may be updated (review V3-S2). */
interface MatchingLogins {
  exact: SavedLogin[];
  /** Subdomain matches: they only tell that the login is saved already. */
  related: SavedLogin[];
}

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

const sameForm = (a: FormKey, b: FormKey) => a.origin === b.origin && a.signature === b.signature;

/** What to do with this login and password, given the saved logins for its address. */
function decideFor(logins: MatchingLogins, username: string, password: string): save.SaveDecision {
  return save.decideSave(username, password, logins.exact, logins.related);
}

/**
 * The preview while the user edits the panel. Without a password only the login counts (like the phone's review):
 * update the first entry with it, else create.
 */
function previewDecision(
  logins: MatchingLogins,
  username: string,
  password: string,
): save.SaveDecision {
  if (password !== "") return decideFor(logins, username, password);
  const wanted = username.trim().toLowerCase();
  const sameLogin = logins.exact.find((l) => l.username.trim().toLowerCase() === wanted);
  return sameLogin ? { kind: "update", id: sameLogin.id } : { kind: "create" };
}

const entryNameOf = (logins: MatchingLogins, id: string) =>
  logins.exact.find((l) => l.id === id)?.entryName;

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
    const candidate = (await this.all())[String(tabId)];
    if (!candidate) return undefined;
    if (this.deps.now() - candidate.at >= SAVE_TTL_MS) {
      await this.drop(tabId);
      return undefined;
    }
    return candidate;
  }

  private async byId(id: string): Promise<Candidate | undefined> {
    const found = Object.values(await this.all()).find((c) => c.id === id);
    return found && (await this.forTab(found.tabId));
  }

  /** Saved logins for the candidate's address; null when the vault is locked. */
  private async matching(
    store: VaultStore,
    candidate: Candidate,
    touch: boolean,
  ): Promise<MatchingLogins | null> {
    if (!(await store.resume({ touch }))) return null;
    const entries = store.listEntries("login");
    const toMatch = (e: (typeof entries)[number]) => ({
      name: e.data.name,
      urls: e.data.type === "login" ? e.data.fields.urls : [],
    });
    const exactIds = new Set(
      autofill.matchLogins(candidate.url, entries, toMatch, { exactOnly: true }).map((e) => e.id),
    );
    const all = autofill.matchLogins(candidate.url, entries, toMatch).flatMap((e) =>
      e.data.type === "login"
        ? [
            {
              id: e.id,
              entryName: e.data.name,
              username: e.data.fields.username,
              password: e.data.fields.password,
            },
          ]
        : [],
    );
    return {
      exact: all.filter((l) => exactIds.has(l.id)),
      related: all.filter((l) => !exactIds.has(l.id)),
    };
  }

  /** What to do with the candidate's own login and password; null when the vault is locked. */
  private async decide(candidate: Candidate): Promise<save.SaveDecision | null> {
    const logins = await this.matching(this.deps.store(), candidate, false);
    return logins && decideFor(logins, candidate.username, candidate.password);
  }

  private fromScript(sender: Sender): { tabId: number; frame: URL } | undefined {
    const frame = webUrl(sender.url);
    if (sender.id !== this.deps.selfId || sender.tab?.id === undefined || !frame) return undefined;
    return { tabId: sender.tab.id, frame };
  }

  private fromExtensionPage(sender: Sender): boolean {
    return sender.id === this.deps.selfId && parseUrl(sender.url)?.protocol === "chrome-extension:";
  }

  onCandidate(message: SaveCandidateMessage, sender: Sender): Promise<void> {
    return this.serial(() => this.handleCandidate(message, sender));
  }

  private async handleCandidate(message: SaveCandidateMessage, sender: Sender): Promise<void> {
    const from = this.fromScript(sender);
    if (!from) return;
    const tab = webUrl(sender.tab?.url);
    if (!tab || tab.origin !== from.frame.origin) return;
    const url = save.saveUrl(from.frame.href);
    if (url === null || message.password === "") return;
    if ((await neverList(this.deps.local)).includes(save.saveName(url))) return;

    const now = this.deps.now();
    const form: FormKey = { origin: from.frame.origin, signature: message.formSignature };
    // One submission fires several reports (click, Enter, submit): the same login keeps its id, so the panel
    // already on the page stays valid.
    const previous = await this.forTab(from.tabId);
    const same =
      previous?.username === message.username &&
      previous.password === message.password &&
      sameForm(previous.form, form);
    const candidate: Candidate = {
      id: same ? previous.id : this.deps.newId(),
      tabId: from.tabId,
      url,
      username: message.username,
      password: message.password,
      at: now,
      form,
    };
    if ((await this.decide(candidate))?.kind === "none") return;

    const all = await this.all();
    all[String(from.tabId)] = candidate;
    await this.write(all);
    await this.deps.alarms.create(alarmName(from.tabId), { when: now + SAVE_TTL_MS });
    await this.deps.prompt.show(from.tabId, candidate.id);
  }

  onPending(message: SavePendingMessage, sender: Sender): Promise<{ candidateId?: string }> {
    return this.serial(() => this.handlePending(message, sender));
  }

  private async handlePending(
    message: SavePendingMessage,
    sender: Sender,
  ): Promise<{ candidateId?: string }> {
    const from = this.fromScript(sender);
    if (!from || webUrl(sender.tab?.url)?.origin !== from.frame.origin) return {};
    const candidate = await this.forTab(from.tabId);
    if (!candidate) return {};
    // The same login form again, empty: the login most likely failed, so do not ask about it on this page.
    if (
      from.frame.origin === candidate.form.origin &&
      message.emptyLoginForms.includes(candidate.form.signature)
    ) {
      await this.deps.prompt.closeWindow(from.tabId);
      return {};
    }
    if (candidate.dismissed) {
      await this.deps.prompt.badge(from.tabId);
      return {};
    }
    await this.deps.prompt.show(from.tabId, candidate.id);
    return { candidateId: candidate.id };
  }

  onInfo(message: SaveInfoMessage, sender: Sender): Promise<SavePromptInfo | undefined> {
    return this.serial(() => this.handleInfo(message, sender));
  }

  /** The candidate a save-info message names, by id or else by tab. */
  private async named(message: SaveInfoMessage): Promise<Candidate | undefined> {
    if (message.candidateId !== undefined) return this.byId(message.candidateId);
    if (message.tabId !== undefined) return this.forTab(message.tabId);
    return undefined;
  }

  private async handleInfo(
    message: SaveInfoMessage,
    sender: Sender,
  ): Promise<SavePromptInfo | undefined> {
    if (!this.fromExtensionPage(sender)) return undefined;
    const candidate = await this.named(message);
    if (!candidate) return undefined;
    const base = {
      id: candidate.id,
      host: save.saveName(candidate.url),
      username: candidate.username,
    };
    const logins = await this.matching(this.deps.store(), candidate, false);
    if (logins === null) return { ...base, password: "", decision: null, locked: true };
    const decision = decideFor(logins, candidate.username, candidate.password);
    if (decision.kind === "none") {
      await this.drop(candidate.tabId);
      return undefined;
    }
    const info = { ...base, password: candidate.password, locked: false as const };
    if (decision.kind === "create") return { ...info, decision: "create" };
    return { ...info, decision: "update", entryName: entryNameOf(logins, decision.id) };
  }

  onPreview(message: SavePreviewMessage, sender: Sender): Promise<SavePreviewResponse> {
    return this.serial(() => this.handlePreview(message, sender));
  }

  private async handlePreview(
    message: SavePreviewMessage,
    sender: Sender,
  ): Promise<SavePreviewResponse> {
    if (!this.fromExtensionPage(sender)) return undefined;
    const candidate = await this.byId(message.candidateId);
    if (!candidate) return undefined;
    const logins = await this.matching(this.deps.store(), candidate, false);
    if (!logins) return undefined;
    const decision = previewDecision(logins, message.username, message.password);
    if (decision.kind !== "update") return { decision: decision.kind };
    return { decision: "update", entryName: entryNameOf(logins, decision.id) };
  }

  onAnswer(message: SaveAnswerMessage, sender: Sender): Promise<ActionResult> {
    return this.serial(() => this.handleAnswer(message, sender));
  }

  private async handleAnswer(message: SaveAnswerMessage, sender: Sender): Promise<ActionResult> {
    if (!this.fromExtensionPage(sender)) return { ok: false, error: NOT_ALLOWED };
    const candidate = await this.byId(message.candidateId);
    // Nothing left to decline (expired or replaced; a newer candidate already has the window): the page closes itself.
    if (!candidate) return message.answer === "save" ? { ok: false, error: GONE } : { ok: true };
    if (message.answer === "save") return this.answerSave(candidate, message.draft);
    if (message.answer === "never") await this.addToNever(candidate);
    await this.remove(candidate.tabId);
    await this.hide(candidate.tabId);
    return { ok: true };
  }

  /** "Nigdy dla tej strony": the candidate's host goes on the never list. */
  private async addToNever(candidate: Candidate): Promise<void> {
    const never = await neverList(this.deps.local);
    const host = save.saveName(candidate.url);
    if (!never.includes(host)) await this.deps.local.set(STORAGE_KEYS.saveNever, [...never, host]);
  }

  /** "Zapisz": saves the draft (or the candidate's own data) as a new login or a new password of a saved one. */
  private async answerSave(
    candidate: Candidate,
    draft: SaveDraft | undefined,
  ): Promise<ActionResult> {
    const toSave = draft ?? {
      name: "",
      username: candidate.username,
      password: candidate.password,
    };
    if (toSave.password === "") return { ok: false, error: EMPTY_PASSWORD };
    const store = this.deps.store();
    const logins = await this.matching(store, candidate, true);
    if (logins === null) return { ok: false, error: UNLOCK_AND_RETRY };
    const decision = decideFor(logins, toSave.username, toSave.password);
    // Remove first: whatever happens next, the candidate cannot be saved twice.
    await this.remove(candidate.tabId);
    if (decision.kind === "none") {
      await this.hide(candidate.tabId);
      // A draft can name a login saved meanwhile: tell the panel instead of pretending it saved.
      return draft ? { ok: false, error: ALREADY_SAVED } : { ok: true };
    }
    if (decision.kind === "update") {
      const entry = store.getEntry(decision.id);
      if (entry?.data.type !== "login") {
        await this.hide(candidate.tabId);
        return { ok: false, error: GONE };
      }
      await store.putEntry(decision.id, save.withPassword(entry.data, toSave.password));
    } else {
      await store.putEntry(this.deps.newId(), {
        ...save.newLogin(candidate.url, toSave.username, toSave.password),
        name: toSave.name.trim() || save.saveName(candidate.url),
      });
    }
    // The window shows "Zapisano" by itself; it is closed a moment later.
    this.deps.later(SAVED_HIDE_MS, () => {
      void this.hide(candidate.tabId).catch(() => undefined);
    });
    return { ok: true };
  }

  onAlarm(name: string): Promise<void> {
    return this.serial(() => this.handleAlarm(name));
  }

  private async handleAlarm(name: string): Promise<void> {
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
      const candidate = all[String(tabId)];
      if (!candidate) return;
      all[String(tabId)] = { ...candidate, dismissed: true };
      await this.write(all);
    });
  }

  /** The tab of the candidate the question window asks to unlock for; undefined for a foreign sender or none. */
  onUnlockRequest(message: SaveUnlockMessage, sender: Sender): Promise<number | undefined> {
    return this.serial(async () =>
      this.fromExtensionPage(sender) ? (await this.byId(message.candidateId))?.tabId : undefined,
    );
  }
}
