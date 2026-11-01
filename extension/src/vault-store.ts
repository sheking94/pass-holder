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

const LOCAL_VAULT_AAD = "passholder/v1/local-vault";

/** Keys in chrome.storage. account, vault and generator are in local storage, sessionKeys in session storage. */
export const STORAGE_KEYS = {
  account: "account",
  vault: "vault",
  sessionKeys: "keys",
  generator: "generator",
} as const;

/** A token this close to expiry is renewed before a sync, so it does not run out halfway. */
const TOKEN_REFRESH_MARGIN_MS = 10_000;

const LOCKED = "Sejf jest zablokowany";
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
  serverUrl: string;
  kdf: KdfParams;
  wrappedVaultKey: string;
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

  getAccount(): Promise<Account | undefined> {
    return this.local.get<Account>(STORAGE_KEYS.account);
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

  async delete(id: string): Promise<void> {
    deleteEntry(this.requireVault(), id, this.now());
    await this.save();
  }

  /** Creates a new vault on an empty server. */
  async createVault(serverUrl: string, setupToken: string, masterPassword: string): Promise<void> {
    const client = this.makeClient(serverUrl);
    const kdf = newKdfParams();
    const keys = await deriveKeys(masterPassword, kdf);
    const vaultKey = newVaultKey();
    const wrappedVaultKey = await wrapVaultKey(keys.encKey, vaultKey);
    await client.setup({ setupToken, kdf, authKey: toBase64(keys.authKey), wrappedVaultKey });
    await this.local.set(STORAGE_KEYS.account, { serverUrl, kdf, wrappedVaultKey } satisfies Account);
    await this.startSession(vaultKey, keys.authKey, emptyVault());
  }

  /** Connects this browser to a vault that already exists on the server, then downloads it. */
  async connectExisting(serverUrl: string, masterPassword: string): Promise<void> {
    const client = this.makeClient(serverUrl);
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
    await this.local.set(STORAGE_KEYS.account, { serverUrl, kdf, wrappedVaultKey: session.wrappedVaultKey } satisfies Account);
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

  /** Forgets this browser's account and local copy. The server keeps everything. */
  async disconnect(): Promise<void> {
    await this.lock();
    await this.local.remove(STORAGE_KEYS.account);
    await this.local.remove(STORAGE_KEYS.vault);
  }

  async sync(): Promise<void> {
    const vault = this.requireVault();
    const keys = this.requireKeys();
    const account = await this.getAccount();
    if (!account) throw new Error(LOCKED);
    const client = this.makeClient(account.serverUrl);
    const vaultKey = fromBase64(keys.vaultKey);
    await this.withFreshToken(client, (token) => syncVault(vault, vaultKey, (request) => client.sync(token, request)));
    await this.save();
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
