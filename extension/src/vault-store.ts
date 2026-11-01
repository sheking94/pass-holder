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
import { createPinLock, isValidPin, MAX_PIN_ATTEMPTS, openPinLock, WrongPinError, type PinLock, type UnlockKeys } from "./pin-lock.ts";
import { sameEntry, type ImportedEntry } from "./csv-transfer.ts";
import { normalizeServerUrls, pickServer } from "./server-urls.ts";

const LOCAL_VAULT_AAD = "passholder/v1/local-vault";

/**
 * Keys in chrome.storage. account, vault and generator are in local storage, sessionKeys in session storage.
 * pinLock is in session storage, or in local storage if the user wants the PIN to survive a browser restart.
 */
export const STORAGE_KEYS = {
  account: "account",
  vault: "vault",
  sessionKeys: "keys",
  generator: "generator",
  pinLock: "pinLock",
} as const;

/** A token this close to expiry is renewed before a sync, so it does not run out halfway. */
const TOKEN_REFRESH_MARGIN_MS = 10_000;

const LOCKED = "Sejf jest zablokowany";
const INVALID_PIN = "PIN musi mieć od 4 do 6 cyfr";
export const NO_VAULT_ON_SERVER = "Na serwerze nie ma jeszcze sejfu. Wybierz „Nowy sejf” i załóż go.";

/** Key-value storage; chrome.storage.local and chrome.storage.session in the extension, a Map in tests. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function chromeStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

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

function toUrlList(serverUrls: string | readonly string[]): string[] {
  const urls = normalizeServerUrls(typeof serverUrls === "string" ? [serverUrls] : serverUrls);
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

/** Whether unlocking with a PIN is on, and how. */
export interface PinStatus {
  /** True if the PIN is kept on disk and works after a browser restart. */
  rememberedAfterRestart: boolean;
  attemptsLeft: number;
}

/** An entry that is not deleted, as the popup lists and edits it. */
export type LiveEntry = LocalEntry & { deleted: false };

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

  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly makeClient: (url: string) => ServerClient = (url) => new ServerClient(url),
    private readonly now: () => number = Date.now,
  ) {}

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
    if (!account) throw new Error("Ta przeglądarka nie jest połączona z serwerem");
    const urls = toUrlList(serverUrls);
    const lastServerUrl = account.lastServerUrl && urls.includes(account.lastServerUrl) ? account.lastServerUrl : undefined;
    await this.saveAccount({ ...account, serverUrls: urls, lastServerUrl });
  }

  isUnlocked(): boolean {
    return this.vault !== undefined;
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
  async importEntries(entries: readonly ImportedEntry[], newId: () => string = () => crypto.randomUUID()): Promise<{ added: number; duplicates: number }> {
    const vault = this.requireVault();
    const known: ImportedEntry[] = liveEntries(vault).map((e) => e.data);
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
  async createVault(serverUrls: string | readonly string[], setupToken: string, masterPassword: string): Promise<void> {
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
  async connectExisting(serverUrls: string | readonly string[], masterPassword: string): Promise<void> {
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
    if (!account) throw new Error("Ta przeglądarka nie jest połączona z serwerem");
    const keys = await deriveKeys(masterPassword, account.kdf);
    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKey(keys.encKey, account.wrappedVaultKey);
    } catch {
      throw new Error("Złe hasło główne");
    }
    await this.startSession(vaultKey, keys.authKey, await this.loadVault(vaultKey));
    await this.resetPinAttempts();
  }

  /**
   * Works offline like unlock(), but with the PIN set in enablePin(). Every wrong PIN counts; after
   * MAX_PIN_ATTEMPTS in a row the PIN is deleted and only the master password works.
   */
  async unlockWithPin(pin: string): Promise<void> {
    if (!(await this.getAccount())) throw new Error("Ta przeglądarka nie jest połączona z serwerem");
    if (!isValidPin(pin)) throw new Error(INVALID_PIN);
    const found = await this.findPinLock();
    if (!found) throw new Error("PIN jest wyłączony. Odblokuj hasłem głównym.");
    const { lock, area } = found;
    const attempts = lock.failedAttempts + 1;
    // Counted before checking, so closing the popup during the slow Argon2id does not give a free guess.
    await area.set(STORAGE_KEYS.pinLock, { ...lock, failedAttempts: attempts } satisfies PinLock);
    let keys: UnlockKeys;
    try {
      keys = await openPinLock(pin, lock);
    } catch (error) {
      if (!(error instanceof WrongPinError)) throw error;
      if (attempts >= MAX_PIN_ATTEMPTS) {
        await this.disablePin();
        throw new Error("Zły PIN. To była ostatnia próba: PIN został wyłączony, odblokuj hasłem głównym.");
      }
      throw new Error(`Zły PIN. Pozostało prób: ${MAX_PIN_ATTEMPTS - attempts}.`);
    }
    await area.set(STORAGE_KEYS.pinLock, { ...lock, failedAttempts: 0 } satisfies PinLock);
    await this.startSession(keys.vaultKey, keys.authKey, await this.loadVault(keys.vaultKey));
  }

  /** undefined when the PIN is off. */
  async pinStatus(): Promise<PinStatus | undefined> {
    const found = await this.findPinLock();
    if (!found) return undefined;
    return {
      rememberedAfterRestart: found.area === this.local,
      attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - found.lock.failedAttempts),
    };
  }

  /**
   * Turns on unlocking with a PIN (needs an unlocked vault). By default the PIN is kept in session
   * storage, which Chrome holds in memory only, so after a browser restart the master password is needed.
   * With rememberAfterRestart it goes to local storage, on disk, where a copy can be brute-forced offline.
   */
  async enablePin(pin: string, rememberAfterRestart: boolean): Promise<void> {
    if (!isValidPin(pin)) throw new Error(INVALID_PIN);
    const keys = this.requireKeys();
    const lock = await createPinLock(pin, { vaultKey: fromBase64(keys.vaultKey), authKey: fromBase64(keys.authKey) });
    await this.disablePin();
    await (rememberAfterRestart ? this.local : this.session).set(STORAGE_KEYS.pinLock, lock);
  }

  async disablePin(): Promise<void> {
    await this.session.remove(STORAGE_KEYS.pinLock);
    await this.local.remove(STORAGE_KEYS.pinLock);
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

  /** Session storage first: enablePin() keeps the PIN in only one of the two. */
  private async findPinLock(): Promise<{ lock: PinLock; area: KeyValueStore } | undefined> {
    for (const area of [this.session, this.local]) {
      const lock = await area.get<PinLock>(STORAGE_KEYS.pinLock);
      if (lock) return { lock, area };
    }
    return undefined;
  }

  private async resetPinAttempts(): Promise<void> {
    const found = await this.findPinLock();
    if (found && found.lock.failedAttempts > 0) {
      await found.area.set(STORAGE_KEYS.pinLock, { ...found.lock, failedAttempts: 0 } satisfies PinLock);
    }
  }

  private async saveAccount(account: Account): Promise<void> {
    await this.local.set(STORAGE_KEYS.account, account);
  }

  private requireVault(): LocalVault {
    if (!this.vault) throw new Error(LOCKED);
    return this.vault;
  }

  private requireKeys(): SessionKeys {
    if (!this.keys) throw new Error(LOCKED);
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
