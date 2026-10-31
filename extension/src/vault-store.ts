import {
  assertKdfParamsAcceptable,
  deriveKeys,
  emptyVault,
  fromBase64,
  fromUtf8,
  newKdfParams,
  newVaultKey,
  open,
  seal,
  syncVault,
  toBase64,
  unwrapVaultKey,
  utf8,
  wrapVaultKey,
  type KdfParams,
  type LocalEntry,
  type LocalVault,
} from "@passholder/core";
import { ApiError, ServerClient } from "./api.ts";

const LOCAL_VAULT_AAD = "passholder/v1/local-vault";

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
    return this.local.get<Account>("account");
  }

  isUnlocked(): boolean {
    return this.vault !== undefined;
  }

  entries(): LocalVault["entries"] {
    if (!this.vault) throw new Error("Vault is locked");
    return this.vault.entries;
  }

  vaultForEdit(): LocalVault {
    if (!this.vault) throw new Error("Vault is locked");
    return this.vault;
  }

  /** Creates a new vault on an empty server. */
  async createVault(serverUrl: string, setupToken: string, masterPassword: string): Promise<void> {
    const client = this.makeClient(serverUrl);
    const kdf = newKdfParams();
    const keys = await deriveKeys(masterPassword, kdf);
    const vaultKey = newVaultKey();
    const wrappedVaultKey = await wrapVaultKey(keys.encKey, vaultKey);
    await client.setup({ setupToken, kdf, authKey: toBase64(keys.authKey), wrappedVaultKey });
    await this.local.set("account", { serverUrl, kdf, wrappedVaultKey } satisfies Account);
    await this.startSession(vaultKey, keys.authKey, emptyVault());
  }

  /** Connects this browser to a vault that already exists on the server, then downloads it. */
  async connectExisting(serverUrl: string, masterPassword: string): Promise<void> {
    const client = this.makeClient(serverUrl);
    const { kdf } = await client.prelogin();
    assertKdfParamsAcceptable(kdf);
    const keys = await deriveKeys(masterPassword, kdf);
    const authKey = toBase64(keys.authKey);
    const session = await client.session(authKey).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, "Złe hasło główne");
      throw error;
    });
    const vaultKey = await unwrapVaultKey(keys.encKey, session.wrappedVaultKey);
    await this.local.set("account", { serverUrl, kdf, wrappedVaultKey: session.wrappedVaultKey } satisfies Account);
    await this.startSession(vaultKey, keys.authKey, emptyVault());
    this.keys = { ...this.keys!, token: session.token, tokenExpiresAt: session.expiresAt };
    await this.session.set("keys", this.keys);
    await this.sync();
  }

  /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
  async unlock(masterPassword: string): Promise<void> {
    const account = await this.getAccount();
    if (!account) throw new Error("No account");
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
    const keys = await this.session.get<SessionKeys>("keys");
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
    await this.session.remove("keys");
  }

  /** Forgets this browser's account and local copy. The server keeps everything. */
  async disconnect(): Promise<void> {
    await this.lock();
    await this.local.remove("account");
    await this.local.remove("vault");
  }

  /** Call after each change made through vaultForEdit(). */
  async save(): Promise<void> {
    if (!this.vault || !this.keys) throw new Error("Vault is locked");
    const blob = await seal(fromBase64(this.keys.vaultKey), utf8(serializeVault(this.vault)), LOCAL_VAULT_AAD);
    await this.local.set("vault", blob);
    await this.touch();
  }

  async sync(): Promise<void> {
    const account = await this.getAccount();
    if (!this.vault || !this.keys || !account) throw new Error("Vault is locked");
    const client = this.makeClient(account.serverUrl);
    if (!this.keys.token || (this.keys.tokenExpiresAt ?? 0) <= this.now() + 10_000) await this.logIn(client);
    const vaultKey = fromBase64(this.keys.vaultKey);
    try {
      await syncVault(this.vault, vaultKey, (request) => client.sync(this.keys!.token!, request));
    } catch (error) {
      // The server keeps sessions in memory only, so switching the Pi off and on forgets our token
      // although it has not expired yet. Log in again once and retry.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      await this.logIn(client);
      await syncVault(this.vault, vaultKey, (request) => client.sync(this.keys!.token!, request));
    }
    await this.save();
  }

  private async logIn(client: ServerClient): Promise<void> {
    const session = await client.session(this.keys!.authKey);
    this.keys = { ...this.keys!, token: session.token, tokenExpiresAt: session.expiresAt };
    await this.session.set("keys", this.keys);
  }

  private async startSession(vaultKey: Uint8Array, authKey: Uint8Array, vault: LocalVault): Promise<void> {
    this.vault = vault;
    this.keys = { vaultKey: toBase64(vaultKey), authKey: toBase64(authKey), unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.save();
  }

  private async touch(): Promise<void> {
    if (!this.keys) return;
    this.keys = { ...this.keys, unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.session.set("keys", this.keys);
  }

  private async loadVault(vaultKey: Uint8Array): Promise<LocalVault> {
    const blob = await this.local.get<string>("vault");
    if (!blob) return emptyVault();
    return deserializeVault(fromUtf8(await open(vaultKey, blob, LOCAL_VAULT_AAD)));
  }
}
