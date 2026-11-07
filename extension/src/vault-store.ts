import {
  assertKdfParamsAcceptable,
  deriveKeys,
  fromBase64,
  fromUtf8,
  open,
  p2p,
  randomBytes,
  seal,
  toBase64,
  unwrapVaultKey,
  utf8,
  type KdfParams,
} from "@passholder/core";
import { PhoneClient, phoneErrorInPolish } from "./phone-client.ts";
import { invalidPinMessage, isValidPin } from "./pin-lock.ts";
import { PinStore, type PinStatus } from "./pin-store.ts";
import { learnedPhoneUrls, normalizePhoneUrls, pickServer } from "./server-urls.ts";
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";

export { chromeStore, memoryStore, STORAGE_KEYS, type KeyValueStore } from "./storage.ts";
export type { PinStatus } from "./pin-store.ts";

const LOCAL_VAULT_AAD = "passholder/v2/local-vault";
const STATIC_KEY_AAD = "passholder/v2/ext-static-key";

const LOCKED = "Sejf jest zablokowany";
const NOT_PAIRED = "Ta przeglądarka nie jest sparowana z telefonem";
const WRONG_PASSWORD = "Złe hasło główne";
export const OTHER_VAULT = "To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem.";
const NO_PENDING_PAIRING = "Najpierw sparuj przeglądarkę z telefonem (kod z ekranu Synchronizacja).";
const NO_ALLOWED_ADDRESS =
  "Brak zgody Chrome na łączenie z żadnym adresem telefonu. Otwórz „Adresy telefonu” i zapisz adresy, a Chrome zapyta o zgodę.";
export const PHONE_WAITS_FOR_RESTORE =
  "Telefon czeka na odtworzenie sejfu z wtyczki, a ta przeglądarka nie ma jeszcze sejfu. Na telefonie wybierz „Dodaj wtyczkę” albo odtwórz sejf z przeglądarki, która go ma.";

/** Kept on disk. Nothing here is readable without the master password, except the public parts. */
export interface Account {
  /** Every address of the phone, e.g. the home network IP and the Tailscale IP. At least one. */
  phoneUrls: string[];
  /** The address that answered last time; tried first on the next sync. */
  lastPhoneUrl?: string;
  deviceId: string;
  deviceName: string;
  /** The phone's identity from pairing: its static public key authenticates every sync. */
  phone: p2p.DeviceIdentity;
  kdf: KdfParams;
  wrappedVaultKey: string;
  /** This browser's X25519 private key, sealed under the vault key (STATIC_KEY_AAD). */
  sealedStaticKey: string;
  /** Base64 of the matching public key, as the phone knows it. */
  staticPublicKey: string;
}

/**
 * The result of /pair/start…/finish of a new browser, waiting for the master password. Kept in
 * chrome.storage.session: it survives closing the popup (a wrong password can be typed again without a new
 * code), not a browser restart.
 */
interface PendingPairing {
  /** The address that answered. */
  url: string;
  /** Every typed address, `url` among them. */
  urls: string[];
  /** When /pair/finish succeeded; after PAIRING_PENDING_MS the pairing counts as abandoned. */
  createdAt: number;
  deviceId: string;
  deviceName: string;
  /** Base64; memory only, like the session keys. */
  staticPrivateKey: string;
  staticPublicKey: string;
  phone: p2p.DeviceIdentity;
  vaultInfo: p2p.VaultInfo;
}

/** Kept in chrome.storage.session (memory only, gone when the browser closes) while unlocked. */
interface SessionKeys {
  vaultKey: string;
  unlockedUntil: number;
}

export const AUTO_LOCK_MS = 15 * 60_000;

/** How long a pairing waits for the master password before it counts as abandoned (a new code is needed). */
export const PAIRING_PENDING_MS = 10 * 60_000;

/** What the connect screen shows while a pairing waits for the master password. */
export interface PendingPairingInfo {
  phoneName: string;
  /** The addresses the account will start with (typed, then learned from the phone): Chrome must allow each. */
  phoneUrls: string[];
}

/** What a sync did besides syncing: addresses it did not try because Chrome does not allow them yet. */
export interface SyncResult {
  skipped: string[];
}

/**
 * The pairing is saved (the browser is paired and unlocked), but the first sync after it failed. Thrown by
 * pairFinish and repair so the screen can say "paired" rather than "pairing failed".
 */
export class PairedButSyncFailed extends Error {
  constructor(
    readonly mode: "paired" | "restored",
    readonly syncError: unknown,
  ) {
    super(`Sparowano z telefonem, ale pierwsza synchronizacja się nie udała: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
  }
}

/** Runs a call to the phone and turns the core's English errors into Polish ones. */
async function talkToPhone<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw phoneErrorInPolish(error);
  }
}

/**
 * Activity (a click, a key) moves the auto-lock deadline, but writes it to session storage at most this
 * often, so typing does not cause a storage write per key.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** An entry that is not deleted, as the popup lists and edits it. */
export type LiveEntry = p2p.LocalEntryV2 & { deleted: false };

/** What the user sees of an entry, e.g. one row of an imported file. */
export type EntryFields = Pick<p2p.EntryDataV2, "name" | "username" | "password">;

/** What importEntries() did: how many entries were added and how many were already in the vault. */
export interface ImportResult {
  added: number;
  duplicates: number;
}

/** Same name, username and password: importing it again would only make a duplicate. */
function sameEntry(a: EntryFields, b: EntryFields): boolean {
  return a.name === b.name && a.username === b.username && a.password === b.password;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** One typed address as http://IPv4:port; throws a message that names a wrong one. */
function phoneUrl(raw: string): string {
  const [url] = normalizePhoneUrls([raw]);
  if (url === undefined) throw new Error("Podaj adres telefonu");
  return url;
}

function toUrlList(urls: readonly string[]): string[] {
  const out = normalizePhoneUrls(urls);
  if (out.length === 0) throw new Error("Podaj adres telefonu");
  return out;
}

/** urls followed by the usable addresses from learned that are not in it yet. */
function withLearned(urls: readonly string[], learned: readonly string[]): string[] {
  return [...urls, ...learnedPhoneUrls(learned).filter((u) => !urls.includes(u))];
}

function serializeVault(vault: p2p.LocalVaultV2): string {
  return JSON.stringify({
    epoch: vault.epoch,
    lastSyncRevision: vault.lastSyncRevision,
    addresses: vault.addresses,
    entries: [...vault.entries.values()],
  });
}

function deserializeVault(json: string): p2p.LocalVaultV2 {
  const parsed = JSON.parse(json) as { epoch: string | null; lastSyncRevision: number; addresses: string[]; entries: p2p.LocalEntryV2[] };
  return {
    epoch: parsed.epoch,
    lastSyncRevision: parsed.lastSyncRevision,
    addresses: parsed.addresses,
    entries: new Map(parsed.entries.map((e) => [e.id, e])),
  };
}

/** Unwraps the vault key; a wrong password (the GCM tag does not verify) becomes "Złe hasło główne". */
async function unwrapWithPassword(masterPassword: string, kdf: KdfParams, wrappedVaultKey: string): Promise<Uint8Array> {
  const keys = await deriveKeys(masterPassword, kdf);
  try {
    return await unwrapVaultKey(keys.encKey, wrappedVaultKey);
  } catch {
    throw new Error(WRONG_PASSWORD);
  }
}

/**
 * Everything the popup does with the vault. The vault is encrypted with the vault key on disk too,
 * so the extension works offline and only talks to the phone when you sync.
 * Every change (upsert, delete, sync) is saved to disk before the method returns.
 */
export class VaultStore {
  private vault: p2p.LocalVaultV2 | undefined;
  private keys: SessionKeys | undefined;
  private clock: p2p.HlcClock | undefined;
  private readonly pin: PinStore;

  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly makeClient: (url: string) => PhoneClient = (url) => new PhoneClient(url),
    private readonly now: () => number = Date.now,
    /** Whether Chrome lets this page reach the address (host permission); sync skips those it does not. */
    private readonly canReach: (url: string) => Promise<boolean> = async () => true,
  ) {
    this.pin = new PinStore(local, session);
  }

  async getAccount(): Promise<Account | undefined> {
    return this.local.get<Account>(STORAGE_KEYS.account);
  }

  /**
   * Replaces the list of phone addresses. No new pairing is needed: every address leads to the same phone,
   * and the Noise handshake checks its static key on every sync.
   */
  async setPhoneUrls(phoneUrls: readonly string[]): Promise<void> {
    const account = await this.requireAccount();
    const urls = toUrlList(phoneUrls);
    const lastPhoneUrl = account.lastPhoneUrl && urls.includes(account.lastPhoneUrl) ? account.lastPhoneUrl : undefined;
    await this.saveAccount({ ...account, phoneUrls: urls, lastPhoneUrl });
  }

  isUnlocked(): boolean {
    return this.vault !== undefined && !this.expired();
  }

  /** Entries that are not deleted, in no particular order. */
  entries(): LiveEntry[] {
    return p2p.liveEntriesV2(this.requireVault());
  }

  entry(id: string): LiveEntry | undefined {
    const entry = this.requireVault().entries.get(id);
    return entry && !entry.deleted ? entry : undefined;
  }

  /** Number of local changes the phone has not seen yet. */
  pendingCount(): number {
    return [...this.requireVault().entries.values()].filter((e) => e.dirty).length;
  }

  async upsert(id: string, data: EntryFields): Promise<void> {
    p2p.upsertEntryV2(this.requireVault(), this.requireClock(), id, data);
    await this.save();
  }

  /**
   * Adds imported entries as new local changes, skipping any that already exist with the same
   * name, username and password (also duplicates within the import). Saves once at the end.
   * Returns how many were added and how many were duplicates.
   */
  async importEntries(entries: readonly EntryFields[], newId: () => string = () => crypto.randomUUID()): Promise<ImportResult> {
    const vault = this.requireVault();
    const clock = this.requireClock();
    const known: EntryFields[] = p2p.liveEntriesV2(vault).map((e) => e.data);
    let added = 0;
    for (const entry of entries) {
      if (known.some((k) => sameEntry(k, entry))) continue;
      p2p.upsertEntryV2(vault, clock, newId(), { name: entry.name, username: entry.username, password: entry.password });
      known.push(entry);
      added++;
    }
    if (added > 0) await this.save();
    return { added, duplicates: entries.length - added };
  }

  async delete(id: string): Promise<void> {
    p2p.deleteEntryV2(this.requireVault(), this.requireClock(), id);
    await this.save();
  }

  /**
   * First step of pairing a new browser: /pair/hello, start and finish with the code the phone shows.
   * The result (with this browser's new static key) waits in session storage for pairFinish.
   */
  async pairStart(urls: string | readonly string[], code: string, deviceName: string): Promise<{ needsPassword: true }> {
    const typed = typeof urls === "string" ? [phoneUrl(urls)] : toUrlList(urls);
    const name = deviceName.trim();
    if (name.length < 1 || name.length > p2p.MAX_DEVICE_NAME_LENGTH) {
      throw new Error(`Podaj nazwę tego urządzenia (do ${p2p.MAX_DEVICE_NAME_LENGTH} znaków)`);
    }
    if (await this.getAccount()) throw new Error("Ta przeglądarka jest już sparowana. Użyj „Sparuj z innym telefonem”.");
    const { url: baseUrl, client } = await pickServer(typed, this.makeClient);
    // pairWithPhone refuses restore mode too, but only with a short message; this one says what to do.
    if ((await talkToPhone(() => p2p.phoneHello(baseUrl, client.post))).mode === "restore") throw new Error(PHONE_WAITS_FOR_RESTORE);

    const staticKey = p2p.generateKeyPair();
    const identity: p2p.DeviceIdentity = { deviceId: crypto.randomUUID(), name, staticPublicKey: toBase64(staticKey.publicKey) };
    const res = await talkToPhone(() => p2p.pairWithPhone({ baseUrl, code, identity, post: client.post }));
    if (res.mode !== "pair") throw new Error(PHONE_WAITS_FOR_RESTORE);
    const pending: PendingPairing = {
      url: baseUrl,
      urls: [baseUrl, ...typed.filter((u) => u !== baseUrl)],
      createdAt: this.now(),
      deviceId: identity.deviceId,
      deviceName: name,
      staticPrivateKey: toBase64(staticKey.privateKey),
      staticPublicKey: identity.staticPublicKey,
      phone: res.phone,
      vaultInfo: res.vaultInfo,
    };
    await this.session.set(STORAGE_KEYS.pendingPairing, pending);
    return { needsPassword: true };
  }

  /** A pairing waits for the master password (pairStart succeeded, pairFinish not yet). */
  async hasPendingPairing(): Promise<boolean> {
    return (await this.loadPending()) !== undefined;
  }

  async pendingPairing(): Promise<PendingPairingInfo | undefined> {
    const pending = await this.loadPending();
    if (!pending) return undefined;
    return { phoneName: pending.phone.name, phoneUrls: withLearned(pending.urls, pending.vaultInfo.addresses) };
  }

  /** "Anuluj parowanie": forgets the pairing that waits for the password; the next one needs a new code. */
  async cancelPairing(): Promise<void> {
    await this.session.remove(STORAGE_KEYS.pendingPairing);
  }

  /** The pending pairing, unless it is older than PAIRING_PENDING_MS (then it is removed). */
  private async loadPending(): Promise<PendingPairing | undefined> {
    const pending = await this.session.get<PendingPairing>(STORAGE_KEYS.pendingPairing);
    if (!pending) return undefined;
    if (!(typeof pending.createdAt === "number" && this.now() - pending.createdAt < PAIRING_PENDING_MS)) {
      await this.cancelPairing();
      return undefined;
    }
    return pending;
  }

  /**
   * Second step: the master password opens the phone's vault key. A wrong one leaves the pairing in session
   * storage, so it can be typed again without a new code. Then the account is saved and the first sync runs.
   */
  async pairFinish(masterPassword: string): Promise<SyncResult> {
    const pending = await this.loadPending();
    if (!pending) throw new Error(NO_PENDING_PAIRING);
    const { kdf, wrappedVaultKey } = pending.vaultInfo;
    assertKdfParamsAcceptable(kdf);
    const vaultKey = await unwrapWithPassword(masterPassword, kdf, wrappedVaultKey);
    const account: Account = {
      phoneUrls: withLearned(pending.urls, pending.vaultInfo.addresses),
      lastPhoneUrl: pending.url,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      phone: pending.phone,
      kdf,
      wrappedVaultKey,
      sealedStaticKey: await seal(vaultKey, fromBase64(pending.staticPrivateKey), STATIC_KEY_AAD),
      staticPublicKey: pending.staticPublicKey,
    };
    const vault = p2p.emptyVaultV2();
    p2p.applyVaultInfo(vault, pending.vaultInfo);
    await this.disablePin();
    await this.saveAccount(account);
    await this.startSession(vaultKey, vault, account);
    await this.session.remove(STORAGE_KEYS.pendingPairing);
    return this.firstSync("paired");
  }

  /** The sync right after a pairing was saved: its failure must not read as a failed pairing. */
  private async firstSync(mode: "paired" | "restored"): Promise<SyncResult> {
    try {
      return await this.sync();
    } catch (error) {
      throw new PairedButSyncFailed(mode, error);
    }
  }

  /**
   * Pairs this browser (same deviceId and static key) with a phone again, e.g. a new or reinstalled one.
   * A phone waiting for "Odtwórz z wtyczki" gets this browser's vault ("restored"). A phone with a vault
   * ("paired") must hold the same vault key: otherwise nothing changes here and OTHER_VAULT is thrown.
   * The master password is checked first, so a typo does not spend the phone's code.
   */
  async repair(urls: string | readonly string[], code: string, masterPassword: string): Promise<"paired" | "restored"> {
    const account = await this.requireAccount();
    const typed = typeof urls === "string" ? [phoneUrl(urls)] : toUrlList(urls);
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    const vault = await this.loadVault(vaultKey);
    const identity: p2p.DeviceIdentity = { deviceId: account.deviceId, name: account.deviceName, staticPublicKey: account.staticPublicKey };
    const restore: p2p.VaultInfo = {
      // The phone ignores epoch and addresses of a restore, but they must be well formed.
      epoch: vault.epoch ?? toBase64(randomBytes(16)),
      kdf: account.kdf,
      wrappedVaultKey: account.wrappedVaultKey,
      addresses: [],
    };
    const { url: baseUrl, client } = await pickServer(typed, this.makeClient);
    // In pair mode pairWithPhone does not send `restore`: the phone keeps its own vault.
    const res = await talkToPhone(() => p2p.pairWithPhone({ baseUrl, code, identity, post: client.post, restore }));

    let { kdf, wrappedVaultKey } = account;
    if (res.mode === "pair") {
      const phoneKey = await unwrapWithPassword(masterPassword, res.vaultInfo.kdf, res.vaultInfo.wrappedVaultKey).catch(() => undefined);
      if (!phoneKey || !sameBytes(phoneKey, vaultKey)) throw new Error(OTHER_VAULT);
      // Same vault key, perhaps wrapped anew (e.g. the phone changed the KDF): the phone's copy is current.
      ({ kdf, wrappedVaultKey } = res.vaultInfo);
    }
    p2p.applyVaultInfo(vault, res.vaultInfo);
    const updated: Account = {
      ...account,
      phoneUrls: withLearned([baseUrl, ...typed.filter((u) => u !== baseUrl)], res.vaultInfo.addresses),
      lastPhoneUrl: baseUrl,
      phone: res.phone,
      kdf,
      wrappedVaultKey,
    };
    await this.saveAccount(updated);
    await this.startSession(vaultKey, vault, updated);
    const mode = res.mode === "pair" ? "paired" : "restored";
    await this.firstSync(mode);
    return mode;
  }

  /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
  async unlock(masterPassword: string): Promise<void> {
    const account = await this.requireAccount();
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    await this.startSession(vaultKey, await this.loadVault(vaultKey), account);
    await this.pin.resetAttempts();
  }

  /**
   * Works offline like unlock(), but with the PIN set in enablePin(). Every wrong PIN counts; after
   * MAX_PIN_ATTEMPTS in a row the PIN is deleted and only the master password works (see PinStore).
   */
  async unlockWithPin(pin: string): Promise<{ movedToMemory: boolean }> {
    const account = await this.requireAccount();
    const { keys, movedToMemory } = await this.pin.unlock(pin);
    await this.startSession(keys.vaultKey, await this.loadVault(keys.vaultKey), account);
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
    await this.pin.enable(pin, { vaultKey: fromBase64(keys.vaultKey) }, rememberAfterRestart);
  }

  disablePin(): Promise<void> {
    return this.pin.disable();
  }

  /** Restores an unlocked state kept in session storage, so reopening the popup needs no password. */
  async resume(): Promise<boolean> {
    const keys = await this.session.get<SessionKeys>(STORAGE_KEYS.sessionKeys);
    const account = await this.getAccount();
    if (!keys || !account || keys.unlockedUntil <= this.now()) {
      await this.lock();
      return false;
    }
    this.keys = keys;
    this.vault = await this.loadVault(fromBase64(keys.vaultKey));
    this.clock = p2p.clockForVault(this.vault, account.deviceId, this.now);
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
    this.clock = undefined;
    await this.session.remove(STORAGE_KEYS.sessionKeys);
  }

  /** Forgets this browser's account, PIN, local copy and an unfinished pairing. The phone keeps everything. */
  async disconnect(): Promise<void> {
    await this.lock();
    await this.disablePin();
    await this.session.remove(STORAGE_KEYS.pendingPairing);
    await this.local.remove(STORAGE_KEYS.account);
    await this.local.remove(STORAGE_KEYS.vault);
  }

  /**
   * Syncs with the phone at the first address that answers (the one that worked last time is tried first),
   * over Noise KK with this browser's static key and the phone's key from pairing. Addresses the phone
   * reports are added to phoneUrls; typed ones stay. Addresses Chrome does not allow yet (e.g. learned ones
   * the user has not approved) are skipped and returned, so the screen can say where to allow them.
   */
  async sync(): Promise<SyncResult> {
    const vault = this.requireVault();
    const vaultKey = fromBase64(this.requireKeys().vaultKey);
    const clock = this.requireClock();
    const account = await this.requireAccount();
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const u of account.phoneUrls) ((await this.canReach(u)) ? allowed : skipped).push(u);
    if (allowed.length === 0) throw new Error(NO_ALLOWED_ADDRESS);
    const { url, client } = await pickServer(allowed, this.makeClient, account.lastPhoneUrl);
    const staticKey = p2p.keyPairFromPrivateKey(await open(vaultKey, account.sealedStaticKey, STATIC_KEY_AAD));
    const send = p2p.noiseTransport({
      baseUrl: url,
      deviceId: account.deviceId,
      staticKey,
      peerPublicKey: fromBase64(account.phone.staticPublicKey),
      post: client.post,
    });
    await talkToPhone(() => p2p.syncVaultV2(vault, vaultKey, clock, send));
    await this.save();
    const phoneUrls = withLearned(account.phoneUrls, vault.addresses);
    if (url !== account.lastPhoneUrl || phoneUrls.length !== account.phoneUrls.length) {
      await this.saveAccount({ ...account, phoneUrls, lastPhoneUrl: url });
    }
    for (const u of phoneUrls) if (!account.phoneUrls.includes(u) && !(await this.canReach(u))) skipped.push(u);
    return { skipped };
  }

  private async requireAccount(): Promise<Account> {
    const account = await this.getAccount();
    if (!account) throw new Error(NOT_PAIRED);
    return account;
  }

  private async saveAccount(account: Account): Promise<void> {
    await this.local.set(STORAGE_KEYS.account, account);
  }

  /** The 15 minutes have passed. lockIfIdle() then clears the keys; until it runs nothing may use them. */
  private expired(): boolean {
    return this.keys !== undefined && this.keys.unlockedUntil <= this.now();
  }

  private requireVault(): p2p.LocalVaultV2 {
    if (!this.vault || this.expired()) throw new Error(LOCKED);
    return this.vault;
  }

  private requireKeys(): SessionKeys {
    if (!this.keys || this.expired()) throw new Error(LOCKED);
    return this.keys;
  }

  private requireClock(): p2p.HlcClock {
    if (!this.clock || this.expired()) throw new Error(LOCKED);
    return this.clock;
  }

  private async save(): Promise<void> {
    const blob = await seal(fromBase64(this.requireKeys().vaultKey), utf8(serializeVault(this.requireVault())), LOCAL_VAULT_AAD);
    await this.local.set(STORAGE_KEYS.vault, blob);
    await this.touch();
  }

  private async startSession(vaultKey: Uint8Array, vault: p2p.LocalVaultV2, account: Account): Promise<void> {
    this.vault = vault;
    this.clock = p2p.clockForVault(vault, account.deviceId, this.now);
    this.keys = { vaultKey: toBase64(vaultKey), unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.save();
  }

  private async touch(): Promise<void> {
    if (!this.keys) return;
    this.keys = { ...this.keys, unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.session.set(STORAGE_KEYS.sessionKeys, this.keys);
  }

  private async loadVault(vaultKey: Uint8Array): Promise<p2p.LocalVaultV2> {
    const blob = await this.local.get<string>(STORAGE_KEYS.vault);
    if (!blob) return p2p.emptyVaultV2();
    return deserializeVault(fromUtf8(await open(vaultKey, blob, LOCAL_VAULT_AAD)));
  }
}
