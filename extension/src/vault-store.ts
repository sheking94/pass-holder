import {
  assertKdfParamsAcceptable,
  deleteEntry,
  deriveKeys,
  emptyVault,
  fromBase64,
  fromUtf8,
  liveEntries,
  newKdfParams,
  newVaultKey,
  open,
  seal,
  syncVault,
  toBase64,
  unwrapVaultKey,
  upsertEntry,
  utf8,
  wrapVaultKey,
  type EntryData,
  type KdfParams,
  type LocalEntry,
  type LocalVault,
} from "@passholder/core";
import { ApiError, ServerClient, type SessionResponse } from "./api.ts";
import { invalidPinMessage, isValidPin } from "./pin-lock.ts";
import { PinStore, type PinStatus } from "./pin-store.ts";
import { normalizeServerUrls, pickServer } from "./server-urls.ts";
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";

export { chromeStore, memoryStore, STORAGE_KEYS, type KeyValueStore } from "./storage.ts";
export type { PinStatus } from "./pin-store.ts";

const LOCAL_VAULT_AAD = "passholder/v1/local-vault";

/** A token this close to expiry is renewed before a sync, so it does not run out halfway. */
const TOKEN_REFRESH_MARGIN_MS = 10_000;

const LOCKED = "Sejf jest zablokowany";
const NOT_CONNECTED = "Ta przeglądarka nie jest połączona z serwerem";
export const NO_VAULT_ON_SERVER = "Na serwerze nie ma jeszcze sejfu. Wybierz „Nowy sejf” i załóż go.";

/** Kept on disk. Nothing here is readable without the master password. */
export interface Account {
  /** Every address of the same server, e.g. the home network IP and the Tailscale IP. At least one. */
  serverUrls: string[];
  /** The address that answered last time; tried first on the next sync. */
  lastServerUrl?: string;
  kdf: KdfParams;
  wrappedVaultKey: string;
}

/** Version 1.0 stored a single serverUrl. */
type StoredAccount = Omit<Account, "serverUrls"> & { serverUrls?: string[]; serverUrl?: string };

function upgradeAccount(stored: StoredAccount): Account {
  const { serverUrl, serverUrls, ...rest } = stored;
  return { ...rest, serverUrls: serverUrls ?? (serverUrl ? [serverUrl] : []) };
}

function toUrlList(serverUrls: readonly string[]): string[] {
  const urls = normalizeServerUrls(serverUrls);
  if (urls.length === 0) throw new Error("Podaj adres serwera");
  return urls;
}

/** Kept in chrome.storage.session (memory only, gone when the browser closes) while unlocked. */
interface SessionKeys {
  vaultKey: string;
  authKey: string;
  unlockedUntil: number;
  token?: string;
  tokenExpiresAt?: number;
}

export const AUTO_LOCK_MS = 15 * 60_000;

/**
 * Activity (a click, a key) moves the auto-lock deadline, but writes it to session storage at most this
 * often, so typing does not cause a storage write per key.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** An entry that is not deleted, as the popup lists and edits it. */
export type LiveEntry = LocalEntry & { deleted: false };

/** What the user sees of an entry, e.g. one row of an imported file. */
export type EntryFields = Pick<EntryData, "name" | "username" | "password">;

/** What importEntries() did: how many entries were added and how many were already in the vault. */
export interface ImportResult {
  added: number;
  duplicates: number;
}

/** Same name, username and password: importing it again would only make a duplicate. */
function sameEntry(a: EntryFields, b: EntryFields): boolean {
  return a.name === b.name && a.username === b.username && a.password === b.password;
}

function serializeVault(vault: LocalVault): string {
  return JSON.stringify({ lastSyncRevision: vault.lastSyncRevision, entries: [...vault.entries.values()] });
}

function deserializeVault(json: string): LocalVault {
  const parsed = JSON.parse(json) as { lastSyncRevision: number; entries: LocalEntry[] };
  return { lastSyncRevision: parsed.lastSyncRevision, entries: new Map(parsed.entries.map((e) => [e.id, e])) };
}

/**
 * Everything the popup does with the vault. The vault is encrypted with the vault key on disk too,
 * so the extension works offline and only talks to the server when you sync.
 * Every change (upsert, delete, sync) is saved to disk before the method returns.
 */
export class VaultStore {
  private vault: LocalVault | undefined;
  private keys: SessionKeys | undefined;
  private readonly pin: PinStore;

  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly makeClient: (url: string) => ServerClient = (url) => new ServerClient(url),
    private readonly now: () => number = Date.now,
  ) {
    this.pin = new PinStore(local, session);
  }

  async getAccount(): Promise<Account | undefined> {
    const stored = await this.local.get<StoredAccount>(STORAGE_KEYS.account);
    return stored && upgradeAccount(stored);
  }

  /**
   * Replaces the list of server addresses. The vault stays as it is: every address leads to the same
   * server, and the browser checks its certificate on every connection anyway.
   */
  async setServerUrls(serverUrls: readonly string[]): Promise<void> {
    const account = await this.getAccount();
    if (!account) throw new Error(NOT_CONNECTED);
    const urls = toUrlList(serverUrls);
    const lastServerUrl = account.lastServerUrl && urls.includes(account.lastServerUrl) ? account.lastServerUrl : undefined;
    await this.saveAccount({ ...account, serverUrls: urls, lastServerUrl });
  }

  isUnlocked(): boolean {
    return this.vault !== undefined && !this.expired();
  }

  /** Entries that are not deleted, in no particular order. */
  entries(): LiveEntry[] {
    return liveEntries(this.requireVault());
  }

  entry(id: string): LiveEntry | undefined {
    const entry = this.requireVault().entries.get(id);
    return entry && !entry.deleted ? entry : undefined;
  }

  /** Number of local changes the server has not seen yet. */
  pendingCount(): number {
    return [...this.requireVault().entries.values()].filter((e) => e.dirty).length;
  }

  async upsert(id: string, data: Omit<EntryData, "modifiedAt">): Promise<void> {
    upsertEntry(this.requireVault(), id, data, this.now());
    await this.save();
  }

  /**
   * Adds imported entries as new local changes, skipping any that already exist with the same
   * name, username and password (also duplicates within the import). Saves once at the end.
   * Returns how many were added and how many were duplicates.
   */
  async importEntries(entries: readonly EntryFields[], newId: () => string = () => crypto.randomUUID()): Promise<ImportResult> {
    const vault = this.requireVault();
    const known: EntryFields[] = liveEntries(vault).map((e) => e.data);
    let added = 0;
    for (const entry of entries) {
      if (known.some((k) => sameEntry(k, entry))) continue;
      upsertEntry(vault, newId(), entry, this.now());
      known.push(entry);
      added++;
    }
    if (added > 0) await this.save();
    return { added, duplicates: entries.length - added };
  }

  async delete(id: string): Promise<void> {
    deleteEntry(this.requireVault(), id, this.now());
    await this.save();
  }

  /** Creates a new vault on an empty server, reached at the first of serverUrls that answers. */
  async createVault(serverUrls: readonly string[], setupToken: string, masterPassword: string): Promise<void> {
    const urls = toUrlList(serverUrls);
    const { url, client } = await pickServer(urls, this.makeClient);
    const kdf = newKdfParams();
    const keys = await deriveKeys(masterPassword, kdf);
    const vaultKey = newVaultKey();
    const wrappedVaultKey = await wrapVaultKey(keys.encKey, vaultKey);
    await client.setup({ setupToken, kdf, authKey: toBase64(keys.authKey), wrappedVaultKey });
    await this.disablePin();
    await this.saveAccount({ serverUrls: urls, lastServerUrl: url, kdf, wrappedVaultKey });
    await this.startSession(vaultKey, keys.authKey, emptyVault());
  }

  /** Connects this browser to a vault that already exists on the server, then downloads it. */
  async connectExisting(serverUrls: readonly string[], masterPassword: string): Promise<void> {
    const urls = toUrlList(serverUrls);
    const { url, client } = await pickServer(urls, this.makeClient);
    const { kdf } = await client.prelogin().catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) throw new ApiError(404, NO_VAULT_ON_SERVER);
      throw error;
    });
    assertKdfParamsAcceptable(kdf);
    const keys = await deriveKeys(masterPassword, kdf);
    const authKey = toBase64(keys.authKey);
    const session = await client.session(authKey).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, "Złe hasło główne");
      throw error;
    });
    const vaultKey = await unwrapVaultKey(keys.encKey, session.wrappedVaultKey);
    await this.disablePin();
    await this.saveAccount({ serverUrls: urls, lastServerUrl: url, kdf, wrappedVaultKey: session.wrappedVaultKey });
    await this.startSession(vaultKey, keys.authKey, emptyVault());
    await this.rememberToken(session);
    await this.sync();
  }

  /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
  async unlock(masterPassword: string): Promise<void> {
    const account = await this.getAccount();
    if (!account) throw new Error(NOT_CONNECTED);
    const keys = await deriveKeys(masterPassword, account.kdf);
    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKey(keys.encKey, account.wrappedVaultKey);
    } catch {
      throw new Error("Złe hasło główne");
    }
    await this.startSession(vaultKey, keys.authKey, await this.loadVault(vaultKey));
    await this.pin.resetAttempts();
  }

  /**
   * Works offline like unlock(), but with the PIN set in enablePin(). Every wrong PIN counts; after
   * MAX_PIN_ATTEMPTS in a row the PIN is deleted and only the master password works (see PinStore).
   */
  async unlockWithPin(pin: string): Promise<{ movedToMemory: boolean }> {
    if (!(await this.getAccount())) throw new Error(NOT_CONNECTED);
    const { keys, movedToMemory } = await this.pin.unlock(pin);
    await this.startSession(keys.vaultKey, keys.authKey, await this.loadVault(keys.vaultKey));
    return { movedToMemory };
  }

  /** undefined when the PIN is off. */
  pinStatus(): Promise<PinStatus | undefined> {
    return this.pin.status();
  }

  /** Turns on unlocking with a PIN (needs an unlocked vault). See PinStore.enable for where it is kept. */
  async enablePin(pin: string, rememberAfterRestart: boolean): Promise<void> {
    // Before requireKeys(): a PIN of the wrong shape is reported as such even while locked.
    if (!isValidPin(pin, rememberAfterRestart)) throw new Error(invalidPinMessage(rememberAfterRestart));
    const keys = this.requireKeys();
    await this.pin.enable(pin, { vaultKey: fromBase64(keys.vaultKey), authKey: fromBase64(keys.authKey) }, rememberAfterRestart);
  }

  disablePin(): Promise<void> {
    return this.pin.disable();
  }

  /** Restores an unlocked state kept in session storage, so reopening the popup needs no password. */
  async resume(): Promise<boolean> {
    const keys = await this.session.get<SessionKeys>(STORAGE_KEYS.sessionKeys);
    if (!keys || keys.unlockedUntil <= this.now()) {
      await this.lock();
      return false;
    }
    this.keys = keys;
    this.vault = await this.loadVault(fromBase64(keys.vaultKey));
    await this.touch();
    return true;
  }

  /**
   * Called by the page every few seconds and when it becomes visible again. Locks this page when the
   * 15 minutes have passed, or when another page (popup or tab) or the service worker already locked.
   * Another page may also have moved the deadline: then this page adopts it.
   * Returns true when this call locked the vault, so the page should show the locked screen.
   */
  async lockIfIdle(): Promise<boolean> {
    if (!this.keys) return false;
    const stored = await this.session.get<SessionKeys>(STORAGE_KEYS.sessionKeys);
    if (!stored || stored.unlockedUntil <= this.now() || stored.vaultKey !== this.keys.vaultKey) {
      await this.lock();
      return true;
    }
    // A sync in another page may have renewed the token; the deadline is the later of the two.
    this.keys = { ...stored, unlockedUntil: Math.max(stored.unlockedUntil, this.keys.unlockedUntil) };
    return false;
  }

  /**
   * The user did something on the page (clicked, typed): the 15 minutes start again. Does nothing once
   * the deadline has passed, so activity cannot reopen a vault that should already be locked.
   */
  async noteActivity(): Promise<void> {
    if (!this.keys || this.expired()) return;
    if (this.keys.unlockedUntil - this.now() > AUTO_LOCK_MS - ACTIVITY_WRITE_INTERVAL_MS) return;
    await this.touch();
  }

  /** When the vault locks unless the user does something; undefined while locked. */
  unlockedUntil(): number | undefined {
    return this.keys?.unlockedUntil;
  }

  async lock(): Promise<void> {
    this.vault = undefined;
    this.keys = undefined;
    await this.session.remove(STORAGE_KEYS.sessionKeys);
  }

  /** Forgets this browser's account, PIN and local copy. The server keeps everything. */
  async disconnect(): Promise<void> {
    await this.lock();
    await this.disablePin();
    await this.local.remove(STORAGE_KEYS.account);
    await this.local.remove(STORAGE_KEYS.vault);
  }

  async sync(): Promise<void> {
    const vault = this.requireVault();
    const keys = this.requireKeys();
    const account = await this.getAccount();
    if (!account) throw new Error(LOCKED);
    // The session token stays valid at any address: it is the same server.
    const { url, client } = await pickServer(account.serverUrls, this.makeClient, account.lastServerUrl);
    const vaultKey = fromBase64(keys.vaultKey);
    await this.withFreshToken(client, (token) => syncVault(vault, vaultKey, (request) => client.sync(token, request)));
    await this.save();
    if (url !== account.lastServerUrl) await this.saveAccount({ ...account, lastServerUrl: url });
  }

  /**
   * Runs action with a valid session token. The server keeps sessions in memory only, so switching the
   * Pi off and on forgets our token although it has not expired yet: on 401 log in again once and retry.
   */
  private async withFreshToken(client: ServerClient, action: (token: string) => Promise<void>): Promise<void> {
    const keys = this.requireKeys();
    const expiringSoon = (keys.tokenExpiresAt ?? 0) <= this.now() + TOKEN_REFRESH_MARGIN_MS;
    const token = keys.token && !expiringSoon ? keys.token : await this.logIn(client);
    try {
      await action(token);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      await action(await this.logIn(client));
    }
  }

  /** Gets a new session token from the server and returns it. */
  private async logIn(client: ServerClient): Promise<string> {
    const session = await client.session(this.requireKeys().authKey);
    await this.rememberToken(session);
    return session.token;
  }

  private async rememberToken(session: SessionResponse): Promise<void> {
    this.keys = { ...this.requireKeys(), token: session.token, tokenExpiresAt: session.expiresAt };
    await this.session.set(STORAGE_KEYS.sessionKeys, this.keys);
  }

  private async saveAccount(account: Account): Promise<void> {
    await this.local.set(STORAGE_KEYS.account, account);
  }

  /** The 15 minutes have passed. lockIfIdle() then clears the keys; until it runs nothing may use them. */
  private expired(): boolean {
    return this.keys !== undefined && this.keys.unlockedUntil <= this.now();
  }

  private requireVault(): LocalVault {
    if (!this.vault || this.expired()) throw new Error(LOCKED);
    return this.vault;
  }

  private requireKeys(): SessionKeys {
    if (!this.keys || this.expired()) throw new Error(LOCKED);
    return this.keys;
  }

  private async save(): Promise<void> {
    const blob = await seal(fromBase64(this.requireKeys().vaultKey), utf8(serializeVault(this.requireVault())), LOCAL_VAULT_AAD);
    await this.local.set(STORAGE_KEYS.vault, blob);
    await this.touch();
  }

  private async startSession(vaultKey: Uint8Array, authKey: Uint8Array, vault: LocalVault): Promise<void> {
    this.vault = vault;
    this.keys = { vaultKey: toBase64(vaultKey), authKey: toBase64(authKey), unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.save();
  }

  private async touch(): Promise<void> {
    if (!this.keys) return;
    this.keys = { ...this.keys, unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.session.set(STORAGE_KEYS.sessionKeys, this.keys);
  }

  private async loadVault(vaultKey: Uint8Array): Promise<LocalVault> {
    const blob = await this.local.get<string>(STORAGE_KEYS.vault);
    if (!blob) return emptyVault();
    return deserializeVault(fromUtf8(await open(vaultKey, blob, LOCAL_VAULT_AAD)));
  }
}
