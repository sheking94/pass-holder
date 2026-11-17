import {
  assertKdfParamsAcceptable,
  deriveKeys,
  fromBase64,
  fromUtf8,
  hasErrorCode,
  open,
  PassHolderError,
  p2p,
  randomBytes,
  sameBytes,
  seal,
  toBase64,
  transfer,
  unwrapVaultKey,
  utf8,
  type KdfParams,
} from "@passholder/core";
import * as files from "@passholder/core/files";
import { errorMessage, FILE_CORRUPTED, toUserError } from "./error-messages.ts";
import { PhoneClient } from "./phone-client.ts";
import { invalidPinMessage, isValidPin } from "./pin-lock.ts";
import { PinStore, type PinStatus } from "./pin-store.ts";
import { learnedPhoneUrls, normalizePhoneUrls, pickPhone } from "./phone-urls.ts";
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";

export { chromeStore, memoryStore, STORAGE_KEYS, type KeyValueStore } from "./storage.ts";
export type { PinStatus } from "./pin-store.ts";

export const LOCAL_VAULT_AAD = "passholder/v2/local-vault";
const STATIC_KEY_AAD = "passholder/v2/ext-static-key";

const LOCKED = "Sejf jest zablokowany";
const NOT_PAIRED = "Ta przeglądarka nie jest sparowana z telefonem";
const WRONG_PASSWORD = "Złe hasło główne";
/** repair(): the password opens this browser's copy but not the phone's (a new master password, or another vault). */
const PHONE_HAS_OTHER_PASSWORD =
  "To hasło nie otwiera sejfu na telefonie. Jeśli hasło główne zmieniono na telefonie, wpisz nowe hasło i nowy kod.";
const NO_PENDING_PAIRING =
  "Najpierw sparuj przeglądarkę z telefonem (kod z ekranu Synchronizacja).";
const NO_ALLOWED_ADDRESS =
  "Brak zgody Chrome na łączenie z żadnym adresem telefonu. Otwórz „Adresy telefonu” i zapisz adresy, a Chrome zapyta o zgodę.";
export const PHONE_WAITS_FOR_RESTORE =
  "Telefon czeka na odtworzenie sejfu z wtyczki, a ta przeglądarka nie ma jeszcze sejfu. Na telefonie wybierz „Dodaj wtyczkę” albo odtwórz sejf z przeglądarki, która go ma.";

/**
 * After /pair/finish the phone lists this browser in "Urządzenia", so a pairing that is not completed here
 * leaves a device there that nothing uses: this sentence says which one to remove.
 */
export function orphanDeviceNote(deviceName: string, phone = "telefonie"): string {
  return ` Na ${phone} usuń „${deviceName}” z „Urządzenia”.`;
}

export const PAIRING_EXPIRED = "Parowanie wygasło. Poproś telefon o nowy kod.";

export function pairingExpiredMessage(deviceName: string): string {
  return PAIRING_EXPIRED + orphanDeviceNote(deviceName);
}

export function pairingCancelledMessage(deviceName: string): string {
  return "Anulowano parowanie." + orphanDeviceNote(deviceName);
}

/** repair() met a phone with another vault; that phone has already added this browser. */
export function otherVaultMessage(deviceName: string): string {
  return (
    "To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem." +
    orphanDeviceNote(deviceName, "nowym telefonie")
  );
}

/** disconnect() without force while the vault is unlocked and has changes the phone has not seen. */
export class UnsyncedChanges extends Error {
  constructor(readonly count: number) {
    super(
      `Niezsynchronizowane zmiany: ${count}. Odłączenie usunie je z tej przeglądarki. Najpierw zsynchronizuj albo wyeksportuj sejf do pliku.`,
    );
  }
}

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
  /** This browser's name, as the phone already lists it in "Urządzenia". */
  deviceName: string;
  /** The addresses the account will start with (typed, then learned from the phone): Chrome must allow each. */
  phoneUrls: string[];
}

/** What the file phase of a sync did; `error` (in Polish) when it stopped early. The entries are synced either way. */
export type FilesOutcome = files.FileSyncResult & { error?: string };

/**
 * What a sync did besides syncing: addresses it did not try because Chrome does not allow them yet, and
 * the outcome of the file phase.
 */
export interface SyncResult {
  skipped: string[];
  files: FilesOutcome;
}

/** What repair() did: paired with a phone that has the vault, or restored an empty one; and what its sync skipped. */
export interface RepairResult extends SyncResult {
  mode: "paired" | "restored";
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
    super(
      `Sparowano z telefonem, ale pierwsza synchronizacja się nie udała: ${errorMessage(syncError)}`,
    );
  }
}

/**
 * Runs a call into the core and turns its coded errors into errors with the user's text (toUserError), so a
 * screen can show `error.message`.
 */
async function inUserTerms<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toUserError(error);
  }
}

/**
 * Activity (a click, a key) moves the auto-lock deadline, but writes it to session storage at most this
 * often, so typing does not cause a storage write per key.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** What importContents() did: how many entries were added, were already in the vault, or were too large. */
export interface ImportResult {
  added: number;
  duplicates: number;
  tooLarge: number;
}

/** An entry of any type that is not deleted, as the typed screens list and edit it; data has no `v` or `hlc`. */
export interface StoredEntry {
  id: string;
  dirty: boolean;
  data: p2p.EntryContent;
}

const OTHER_TYPE = "Ten wpis ma inny typ";
const FILE_NOT_READY = "Plik czeka na synchronizację";

/**
 * Removes local files no live entry of `vault` uses, except files added on this browser and never uploaded
 * (complete, uploadedEpoch null). Every page shares IndexedDB but prunes against its own vault, which may be
 * stale: such a file may belong to an entry another page has saved but not synced yet.
 * Best effort: a failure is ignored (the next prune tries again).
 */
async function pruneUnusedFiles(vault: p2p.LocalVault, store: files.LocalFileStore): Promise<void> {
  try {
    const used = files.usedAttachments(vault);
    for (const id of await store.ids()) {
      if (used.has(id)) continue;
      const state = await store.state(id);
      if (state?.complete && state.uploadedEpoch === null) continue;
      await store.delete(id);
    }
  } catch {
    // Leftover files only take space; they are removed on a later prune or on disconnect.
  }
}

function storedView(e: p2p.LocalEntry): StoredEntry | undefined {
  if (e.deleted) return undefined;
  const { v, hlc, ...data } = e.data;
  return { id: e.id, dirty: e.dirty, data: data as p2p.EntryContent };
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

function serializeVault(vault: p2p.LocalVault): string {
  return JSON.stringify({
    epoch: vault.epoch,
    lastSyncRevision: vault.lastSyncRevision,
    addresses: vault.addresses,
    entries: [...vault.entries.values()],
  });
}

function deserializeVault(json: string): p2p.LocalVault {
  const parsed = JSON.parse(json) as {
    epoch: string | null;
    lastSyncRevision: number;
    addresses: string[];
    entries: { id: string; revision: number; dirty: boolean; deleted: boolean; data: unknown }[];
  };
  // A vault saved by an older version holds v2 data (name, username, password, hlc): parseEntryData makes it a v3 login.
  const entries = parsed.entries.map((e): p2p.LocalEntry =>
    e.deleted
      ? {
          id: e.id,
          revision: e.revision,
          dirty: e.dirty,
          deleted: true,
          data: p2p.parseTombstoneData(e.data),
        }
      : {
          id: e.id,
          revision: e.revision,
          dirty: e.dirty,
          deleted: false,
          data: p2p.parseEntryData(e.data),
        },
  );
  return {
    epoch: parsed.epoch,
    lastSyncRevision: parsed.lastSyncRevision,
    addresses: parsed.addresses,
    entries: new Map(entries.map((e) => [e.id, e])),
  };
}

/**
 * Unwraps the vault key; a wrong password (the GCM tag does not verify) becomes "Złe hasło główne".
 * KDF parameters out of bounds (assertKdfParamsAcceptable) are refused before any hashing.
 */
async function unwrapWithPassword(
  masterPassword: string,
  kdf: KdfParams,
  wrappedVaultKey: string,
): Promise<Uint8Array> {
  // Security review V3-I5: parameters read from disk get the same bounds as those from the phone.
  assertKdfParamsAcceptable(kdf);
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
  private vault: p2p.LocalVault | undefined;
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
    /** Encrypted chunks of attachments (IndexedDB in the extension). */
    private readonly fileStore: files.LocalFileStore = new files.MemoryLocalFileStore(),
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
    const lastPhoneUrl =
      account.lastPhoneUrl && urls.includes(account.lastPhoneUrl)
        ? account.lastPhoneUrl
        : undefined;
    await this.saveAccount({ ...account, phoneUrls: urls, lastPhoneUrl });
  }

  isUnlocked(): boolean {
    return this.vault !== undefined && !this.expired();
  }

  /** Live entries of one type, sorted by name (Polish collation). */
  listEntries(type: p2p.EntryType): StoredEntry[] {
    return [...this.requireVault().entries.values()]
      .flatMap((e) => storedView(e) ?? [])
      .filter((e) => e.data.type === type)
      .sort((a, b) => a.data.name.localeCompare(b.data.name, "pl"));
  }

  /** A live entry of any type. */
  getEntry(id: string): StoredEntry | undefined {
    const entry = this.requireVault().entries.get(id);
    return entry && storedView(entry);
  }

  /**
   * Saves exactly this content under id; a live entry of another type under that id is refused. newFiles
   * (encrypted when chosen in the form) are stored before the entry; if the entry is refused (e.g. too large)
   * they are removed again. Afterwards unused local files are pruned (see pruneUnusedFiles).
   */
  async putEntry(
    id: string,
    content: p2p.EntryContent,
    newFiles: readonly files.EncryptedFile[] = [],
  ): Promise<void> {
    const vault = this.requireVault();
    const clock = this.requireClock();
    const existing = vault.entries.get(id);
    if (existing && !existing.deleted && existing.data.type !== content.type)
      throw new Error(OTHER_TYPE);
    try {
      for (const f of newFiles) await files.storeEncryptedFile(this.fileStore, f);
      // Storing the files takes a while: the vault may have locked meanwhile, then the entry is not saved.
      this.requireKeys();
      try {
        p2p.upsertEntry(vault, clock, id, content);
      } catch (error) {
        throw toUserError(error);
      }
    } catch (error) {
      // Nothing refers to the new files: remove them, without letting a failed delete hide the error.
      for (const f of newFiles) await this.fileStore.delete(f.attachment.id).catch(() => undefined);
      throw error;
    }
    // The entry in memory refers to the new files now, so they stay even if saving to disk fails.
    await this.save();
    await pruneUnusedFiles(vault, this.fileStore);
  }

  /** "ready": the whole file is here; "corrupted": the phone's copy did not match; otherwise "waiting" for a sync. */
  async fileStatus(a: files.Attachment): Promise<"ready" | "waiting" | "corrupted"> {
    if ((await this.fileStore.state(a.id))?.complete) return "ready";
    if ((await this.corruptFiles()).includes(a.id)) return "corrupted";
    return "waiting";
  }

  /** The phone of the current epoch has the whole file (otherwise the screen adds "czeka na synchronizację"). */
  async fileUploaded(a: files.Attachment): Promise<boolean> {
    const vault = this.requireVault();
    const state = await this.fileStore.state(a.id);
    return state !== undefined && state.uploadedEpoch === vault.epoch;
  }

  /** Decrypts a local file for download; only while unlocked. Nothing decrypted is kept. */
  async readFile(a: files.Attachment): Promise<Uint8Array> {
    this.requireVault();
    if (!(await this.fileStore.state(a.id))?.complete) throw new Error(FILE_NOT_READY);
    const blobs: string[] = [];
    for (let index = 0; index < a.chunks; index++) {
      const blob = await this.fileStore.getChunk(a.id, index);
      if (blob === undefined) throw new Error(FILE_CORRUPTED);
      blobs.push(blob);
    }
    try {
      return await files.decryptFile(a, blobs);
    } catch (error) {
      throw toUserError(error);
    }
  }

  /** Ids of files whose download did not match their descriptor; sync skips them. */
  private async corruptFiles(): Promise<string[]> {
    return (await this.local.get<string[]>(STORAGE_KEYS.corruptFiles)) ?? [];
  }

  /** Number of local changes the phone has not seen yet. */
  pendingCount(): number {
    return [...this.requireVault().entries.values()].filter((e) => e.dirty).length;
  }

  /**
   * Adds imported entries of any type as new local changes. An entry whose whole content (see
   * transfer.contentKey) is already in the vault as a live entry, or came earlier in this import,
   * is skipped as a duplicate; one over the size limit is counted in tooLarge. Saves once at the end.
   */
  async importContents(
    entries: readonly p2p.EntryContent[],
    newId: () => string = () => crypto.randomUUID(),
  ): Promise<ImportResult> {
    const vault = this.requireVault();
    const clock = this.requireClock();
    const known = new Set(this.allContents().map(transfer.contentKey));
    // upsertEntry replaces map entries (never edits them in place), so a copy of the map is a full snapshot.
    // The clock only moves forward, which is harmless to keep.
    const snapshot = new Map(vault.entries);
    let added = 0;
    let tooLarge = 0;
    try {
      for (const entry of entries) {
        const key = transfer.contentKey(entry);
        if (known.has(key)) continue;
        try {
          p2p.upsertEntry(vault, clock, newId(), entry);
        } catch (error) {
          if (hasErrorCode(error, "ENTRY_TOO_LARGE")) {
            tooLarge++;
            continue;
          }
          throw error;
        }
        known.add(key);
        added++;
      }
      if (added > 0) await this.save();
    } catch (error) {
      // Nothing half-imported may stay in memory, where it could still reach the disk or the phone later.
      vault.entries.clear();
      for (const [id, entry] of snapshot) vault.entries.set(id, entry);
      throw error;
    }
    return { added, duplicates: entries.length - added - tooLarge, tooLarge };
  }

  /** Content of all live entries of every type (no `v` or `hlc`), for export. */
  allContents(): p2p.EntryContent[] {
    return [...this.requireVault().entries.values()].flatMap((e) => storedView(e)?.data ?? []);
  }

  /**
   * A PassHolder ZIP of all live entries and their files. A file that is not complete here (waiting for sync) or
   * cannot be decrypted is left out and counted in `missing`; locking meanwhile fails the export.
   */
  async exportArchive(): Promise<{
    parts: Uint8Array[];
    entries: number;
    files: number;
    missing: number;
  }> {
    const entries = this.allContents();
    const {
      parts,
      files: written,
      missing,
    } = await transfer.exportPassHolderZip(entries, async (a) => {
      this.requireVault();
      if ((await this.fileStatus(a)) !== "ready") return undefined;
      try {
        return await this.readFile(a);
      } catch {
        // Damaged here: the entry goes out without this file.
        return undefined;
      }
    });
    this.requireVault();
    return { parts, entries: entries.length, files: written, missing };
  }

  /**
   * Imports a PassHolder ZIP. Entries already in the vault (transfer.contentKey, files ignored) are skipped with their
   * files; repeats within the archive are left to importContents. The files of the other entries are read, encrypted
   * and stored under new ids; a file that cannot be read is skipped ("wpis N, nazwa") and its entry comes in
   * without it. Any other failure (damaged archive, file store, the vault locking) imports nothing and removes the
   * files stored so far. Afterwards the stored files no live entry uses (a repeat, a too large entry) are removed.
   */
  async importArchive(bytes: Uint8Array): Promise<{
    parsed: transfer.ParsedArchive;
    result: ImportResult;
    filesAdded: number;
    fileSkips: transfer.ImportSkip[];
  }> {
    const vault = this.requireVault();
    const archive = await inUserTerms(() => transfer.openPassHolderZip(bytes));
    const { parsed } = archive;
    const added: string[] = [];
    let result: ImportResult;
    const fileSkips: transfer.ImportSkip[] = [];
    try {
      // Only against the vault: importContents drops repeats within the archive, and it may refuse the first copy
      // as too large, so a later copy must still bring its files (unused ones are removed below).
      const known = new Set(this.allContents().map(transfer.contentKey));
      const contents: p2p.EntryContent[] = [];
      for (const e of parsed.entries) {
        if (known.has(transfer.contentKey(e.content))) {
          contents.push(e.content);
          continue;
        }
        const attachments: files.Attachment[] = [];
        for (const f of e.files) {
          let plain: Uint8Array;
          try {
            plain = await archive.readFile(f);
            if (plain.length !== f.size) {
              plain.fill(0);
              throw new PassHolderError("ARCHIVE_FILE_SIZE_MISMATCH");
            }
          } catch (error) {
            fileSkips.push({
              at: `wpis ${e.position}, ${f.name}`,
              reason: errorMessage(error),
            });
            continue;
          }
          let encrypted: files.EncryptedFile;
          try {
            encrypted = await files.encryptFile(plain, { name: f.name, mime: f.mime });
          } finally {
            // Only the encrypted chunks are kept.
            plain.fill(0);
          }
          // Noted before storing, so a half-stored file is removed too.
          added.push(encrypted.attachment.id);
          await files.storeEncryptedFile(this.fileStore, encrypted);
          // Storing takes a while: stop as soon as the vault locks.
          this.requireKeys();
          attachments.push(encrypted.attachment);
        }
        contents.push(attachments.length > 0 ? { ...e.content, attachments } : e.content);
      }
      this.requireKeys();
      result = await this.importContents(contents);
    } catch (error) {
      // No entry refers to the new files: remove them, without letting a failed delete hide the error.
      for (const id of added) await this.fileStore.delete(id).catch(() => undefined);
      throw error;
    }
    // The entries are written: from here on only files no live entry uses may be removed (also if the vault has
    // locked since: the vault object still holds the entries).
    const used = files.usedAttachments(vault);
    const filesAdded = added.filter((id) => used.has(id)).length;
    // Best effort, like pruneUnusedFiles; the import itself succeeded. A leftover is removed on disconnect.
    for (const id of added)
      if (!used.has(id)) await this.fileStore.delete(id).catch(() => undefined);
    return { parsed, result, filesAdded, fileSkips };
  }

  async delete(id: string): Promise<void> {
    const vault = this.requireVault();
    p2p.deleteEntry(vault, this.requireClock(), id);
    await this.save();
    await pruneUnusedFiles(vault, this.fileStore);
  }

  /**
   * First step of pairing a new browser: /pair/hello, start and finish with the code the phone shows.
   * The result (with this browser's new static key) waits in session storage for pairFinish.
   */
  async pairStart(
    urls: string | readonly string[],
    code: string,
    deviceName: string,
  ): Promise<{ needsPassword: true }> {
    const typed = typeof urls === "string" ? [phoneUrl(urls)] : toUrlList(urls);
    const name = deviceName.trim();
    if (name.length < 1 || name.length > p2p.MAX_DEVICE_NAME_LENGTH) {
      throw new Error(`Podaj nazwę tego urządzenia (do ${p2p.MAX_DEVICE_NAME_LENGTH} znaków)`);
    }
    if (await this.getAccount())
      throw new Error("Ta przeglądarka jest już sparowana. Użyj „Sparuj z innym telefonem”.");
    const { url: baseUrl, client } = await pickPhone(typed, this.makeClient);
    // pairWithPhone refuses restore mode too, but only with a short message; this one says what to do.
    if ((await inUserTerms(() => p2p.phoneHello(baseUrl, client.post))).mode === "restore")
      throw new Error(PHONE_WAITS_FOR_RESTORE);

    const staticKey = p2p.generateKeyPair();
    const identity: p2p.DeviceIdentity = {
      deviceId: crypto.randomUUID(),
      name,
      staticPublicKey: toBase64(staticKey.publicKey),
    };
    const res = await inUserTerms(() =>
      p2p.pairWithPhone({ baseUrl, code, identity, post: client.post }),
    );
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
    return {
      phoneName: pending.phone.name,
      deviceName: pending.deviceName,
      phoneUrls: withLearned(pending.urls, pending.vaultInfo.addresses),
    };
  }

  /**
   * "Anuluj parowanie": forgets the pairing that waits for the password; the next one needs a new code.
   * Returns the cancelled browser's name (the phone still lists it), or undefined when there was none.
   */
  async cancelPairing(): Promise<string | undefined> {
    const pending = await this.loadPending();
    await this.session.remove(STORAGE_KEYS.pendingPairing);
    return pending?.deviceName;
  }

  /** The pending pairing, unless it has expired (then it is removed). */
  private async loadPending(): Promise<PendingPairing | undefined> {
    const pending = await this.session.get<PendingPairing>(STORAGE_KEYS.pendingPairing);
    if (!pending) return undefined;
    if (this.pendingExpired(pending)) {
      await this.session.remove(STORAGE_KEYS.pendingPairing);
      return undefined;
    }
    return pending;
  }

  /** Older than PAIRING_PENDING_MS, or from the future (the clock moved back): either way not to be trusted. */
  private pendingExpired(pending: PendingPairing): boolean {
    if (typeof pending.createdAt !== "number") return true;
    const age = this.now() - pending.createdAt;
    return age < 0 || age >= PAIRING_PENDING_MS;
  }

  /**
   * Second step: the master password opens the phone's vault key. A wrong one leaves the pairing in session
   * storage, so it can be typed again without a new code. Then the account is saved and the first sync runs.
   */
  async pairFinish(masterPassword: string): Promise<SyncResult> {
    const stored = await this.session.get<PendingPairing>(STORAGE_KEYS.pendingPairing);
    const pending = await this.loadPending();
    if (!pending) {
      // Expired just now: say so, and name the device the phone still lists.
      if (stored && typeof stored.deviceName === "string")
        throw new Error(pairingExpiredMessage(stored.deviceName));
      throw new Error(NO_PENDING_PAIRING);
    }
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
    const vault = p2p.emptyVault();
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
   * Pairs this browser (same deviceId and static key) with a phone again, e.g. a new or reinstalled one, or the
   * same phone after "Zmień hasło główne" (it forgets every paired browser).
   * A phone waiting for "Odtwórz z wtyczki" gets this browser's vault ("restored"). A phone with a vault
   * ("paired") must hold the same vault key: otherwise nothing changes here and otherVaultMessage is thrown.
   * The password may be the one this browser knows, or the phone's new one: then the phone's copy of the vault
   * key must open this browser's sealed static key (same vault). Whenever the wrapping changes, the PIN is
   * turned off, so a password change on the phone also asks for a new PIN here.
   * The password this browser knows is checked first, so a typo does not spend the phone's code; a new password
   * can only be checked against the phone's copy, after the code was used.
   */
  async repair(
    urls: string | readonly string[],
    code: string,
    masterPassword: string,
  ): Promise<RepairResult> {
    const account = await this.requireAccount();
    const typed = typeof urls === "string" ? [phoneUrl(urls)] : toUrlList(urls);
    const knownKey = await unwrapWithPassword(
      masterPassword,
      account.kdf,
      account.wrappedVaultKey,
    ).catch(() => undefined);
    const knownVault = knownKey ? await this.loadVault(knownKey) : undefined;
    const identity: p2p.DeviceIdentity = {
      deviceId: account.deviceId,
      name: account.deviceName,
      staticPublicKey: account.staticPublicKey,
    };
    const { url: baseUrl, client } = await pickPhone(typed, this.makeClient);
    let restore: p2p.VaultInfo | undefined;
    if (knownVault) {
      restore = {
        // The phone ignores epoch and addresses of a restore, but they must be well formed.
        epoch: knownVault.epoch ?? toBase64(randomBytes(16)),
        kdf: account.kdf,
        wrappedVaultKey: account.wrappedVaultKey,
        addresses: [],
      };
    } else if ((await inUserTerms(() => p2p.phoneHello(baseUrl, client.post))).mode === "restore") {
      // Only this browser's vault can restore the phone, and the password does not open it.
      throw new Error(WRONG_PASSWORD);
    }
    // In pair mode pairWithPhone does not send `restore`: the phone keeps its own vault.
    const res = await inUserTerms(() =>
      p2p.pairWithPhone({ baseUrl, code, identity, post: client.post, restore }),
    );
    if (res.mode === "restore" && !knownVault) throw new Error(WRONG_PASSWORD);

    let { kdf, wrappedVaultKey } = account;
    let vaultKey = knownKey;
    let vault = knownVault;
    if (res.mode === "pair") {
      const phoneKey = await unwrapWithPassword(
        masterPassword,
        res.vaultInfo.kdf,
        res.vaultInfo.wrappedVaultKey,
      ).catch(() => undefined);
      if (!phoneKey) throw new Error(knownKey ? PHONE_HAS_OTHER_PASSWORD : WRONG_PASSWORD);
      if (
        knownKey ? !sameBytes(phoneKey, knownKey) : !(await this.opensStaticKey(phoneKey, account))
      ) {
        throw new Error(otherVaultMessage(account.deviceName));
      }
      // Same vault key, perhaps wrapped anew (a new master password on the phone): the phone's copy is current.
      ({ kdf, wrappedVaultKey } = res.vaultInfo);
      vaultKey = phoneKey;
      vault ??= await this.loadVault(phoneKey);
    }
    if (!vaultKey || !vault) throw new Error(WRONG_PASSWORD);
    p2p.applyVaultInfo(vault, res.vaultInfo);
    const updated: Account = {
      ...account,
      phoneUrls: withLearned(
        [baseUrl, ...typed.filter((u) => u !== baseUrl)],
        res.vaultInfo.addresses,
      ),
      lastPhoneUrl: baseUrl,
      phone: res.phone,
      kdf,
      wrappedVaultKey,
    };
    if (wrappedVaultKey !== account.wrappedVaultKey) await this.disablePin();
    await this.saveAccount(updated);
    await this.startSession(vaultKey, vault, updated);
    const mode = res.mode === "pair" ? "paired" : "restored";
    const { skipped, files: filesOutcome } = await this.firstSync(mode);
    return { mode, skipped, files: filesOutcome };
  }

  /** [vaultKey] opens this browser's sealed static key, so it is the key of this browser's vault. */
  private async opensStaticKey(vaultKey: Uint8Array, account: Account): Promise<boolean> {
    try {
      await open(vaultKey, account.sealedStaticKey, STATIC_KEY_AAD);
      return true;
    } catch {
      return false;
    }
  }

  /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
  async unlock(masterPassword: string): Promise<void> {
    const account = await this.requireAccount();
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    await this.startSession(vaultKey, await this.loadVault(vaultKey), account);
    await this.pin.resetAttempts();
  }

  /**
   * Checks the master password again while unlocked, before a plain-text export (security review V3-N6): someone
   * at an unlocked browser cannot take the whole vault in one file without knowing it. Throws "Złe hasło główne"
   * for a password that does not open this vault, and LOCKED when the vault is locked.
   */
  async confirmMasterPassword(masterPassword: string): Promise<void> {
    const keys = this.requireKeys();
    const account = await this.requireAccount();
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    if (toBase64(vaultKey) !== keys.vaultKey) throw new Error(WRONG_PASSWORD);
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
    if (!isValidPin(pin, rememberAfterRestart))
      throw new Error(invalidPinMessage(rememberAfterRestart));
    const keys = this.requireKeys();
    await this.pin.enable(pin, { vaultKey: fromBase64(keys.vaultKey) }, rememberAfterRestart);
  }

  disablePin(): Promise<void> {
    return this.pin.disable();
  }

  /** Restores an unlocked state kept in session storage, so reopening the popup needs no password. */
  async resume(options: { touch?: boolean } = {}): Promise<boolean> {
    const keys = await this.session.get<SessionKeys>(STORAGE_KEYS.sessionKeys);
    const account = await this.getAccount();
    if (!keys || !account || keys.unlockedUntil <= this.now()) {
      await this.lock();
      return false;
    }
    this.keys = keys;
    this.vault = await this.loadVault(fromBase64(keys.vaultKey));
    this.clock = p2p.clockForVault(this.vault, account.deviceId, this.now);
    // Background checks triggered by web pages pass touch: false so they cannot keep the vault unlocked.
    if (options.touch !== false) await this.touch();
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
    this.keys = {
      ...stored,
      unlockedUntil: Math.max(stored.unlockedUntil, this.keys.unlockedUntil),
    };
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

  /**
   * Forgets this browser's account, PIN, local copy, an unfinished pairing and the save-question lists. The phone keeps what it has
   * seen, but local changes it has not are lost: while unlocked, that is refused (UnsyncedChanges) unless
   * `force` says the user confirmed it. While locked they cannot be counted; the screen warns instead.
   */
  async disconnect(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && this.isUnlocked()) {
      const count = this.pendingCount();
      if (count > 0) throw new UnsyncedChanges(count);
    }
    await this.lock();
    await this.disablePin();
    await this.session.remove(STORAGE_KEYS.pendingPairing);
    // Security review V3-I3: the hosts never to ask about and the unanswered save questions belong to this vault too.
    await this.session.remove(STORAGE_KEYS.saveCandidates);
    await this.local.remove(STORAGE_KEYS.saveNever);
    await this.local.remove(STORAGE_KEYS.account);
    await this.local.remove(STORAGE_KEYS.vault);
    // The files are the local copy of the vault's attachments: they go with it. The account is gone already,
    // so a failing IndexedDB only leaves encrypted leftovers behind and must not fail the disconnect.
    try {
      for (const id of await this.fileStore.ids()) await this.fileStore.delete(id);
    } catch {
      // Unreadable without the vault key; a later disconnect tries again.
    }
    await this.local.remove(STORAGE_KEYS.corruptFiles);
  }

  /**
   * Syncs with the phone at the first address that answers (the one that worked last time is tried first),
   * over Noise KK with this browser's static key and the phone's key from pairing. Addresses the phone
   * reports are added to phoneUrls; typed ones stay. Addresses Chrome does not allow yet (e.g. learned ones
   * the user has not approved) are skipped and returned, so the screen can say where to allow them.
   * After the entries, the file phase uploads and downloads attachments over the same address and keys; its
   * failure does not undo the entries and is reported in `files.error` (the next sync resumes).
   */
  async sync(onFileProgress?: (done: number, total: number) => void): Promise<SyncResult> {
    const vault = this.requireVault();
    const vaultKey = fromBase64(this.requireKeys().vaultKey);
    const clock = this.requireClock();
    const account = await this.requireAccount();
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const u of account.phoneUrls) ((await this.canReach(u)) ? allowed : skipped).push(u);
    if (allowed.length === 0) throw new Error(NO_ALLOWED_ADDRESS);
    const { url, client } = await pickPhone(allowed, this.makeClient, account.lastPhoneUrl);
    const staticKey = p2p.keyPairFromPrivateKey(
      await open(vaultKey, account.sealedStaticKey, STATIC_KEY_AAD),
    );
    const noise: p2p.NoiseClientOptions = {
      baseUrl: url,
      deviceId: account.deviceId,
      staticKey,
      peerPublicKey: fromBase64(account.phone.staticPublicKey),
      post: client.post,
    };
    await inUserTerms(() => p2p.syncVault(vault, vaultKey, clock, p2p.noiseTransport(noise)));
    await this.save();
    const filesOutcome = await this.syncFilePhase(
      vault,
      files.noiseFileTransport(noise),
      onFileProgress,
    );
    // Another page may have changed the account during the sync (addresses, a repair): merge into the
    // current one, and only while it is still the same phone; otherwise its state wins.
    const current = await this.getAccount();
    if (!current || current.phone.staticPublicKey !== account.phone.staticPublicKey)
      return { skipped, files: filesOutcome };
    const phoneUrls = withLearned(current.phoneUrls, vault.addresses);
    const lastPhoneUrl = phoneUrls.includes(url) ? url : current.lastPhoneUrl;
    if (lastPhoneUrl !== current.lastPhoneUrl || phoneUrls.length !== current.phoneUrls.length) {
      await this.saveAccount({ ...current, phoneUrls, lastPhoneUrl });
    }
    for (const u of phoneUrls)
      if (!account.phoneUrls.includes(u) && !skipped.includes(u) && !(await this.canReach(u)))
        skipped.push(u);
    return { skipped, files: filesOutcome };
  }

  /**
   * Runs syncFiles and never throws: an error ends up in `error`. Newly found corrupted files are remembered
   * (skipped from now on); ids no live entry uses are dropped from that list. After a complete phase, unused
   * local files are pruned (see pruneUnusedFiles). Once the vault locks (auto-lock, „Zablokuj”) no further
   * request is sent: the phase ends with LOCKED and nothing is pruned.
   */
  private async syncFilePhase(
    vault: p2p.LocalVault,
    send: files.P2pFileTransport,
    onProgress?: (done: number, total: number) => void,
  ): Promise<FilesOutcome> {
    const known = await this.corruptFiles();
    const corrupt = new Set(known);
    // A lock clears this.vault and an unlock loads a new one, so the same object means the same session.
    const whileUnlocked: files.P2pFileTransport = async (request) => {
      if (!this.keys || this.expired() || this.vault !== vault) throw new Error(LOCKED);
      return send(request);
    };
    let outcome: FilesOutcome;
    try {
      outcome = await files.syncFiles(
        vault,
        this.fileStore,
        whileUnlocked,
        onProgress,
        new Set(known),
      );
      for (const id of outcome.corruptedIds) corrupt.add(id);
      await pruneUnusedFiles(vault, this.fileStore);
    } catch (error) {
      outcome = {
        uploaded: 0,
        downloaded: 0,
        pending: 0,
        corrupted: [],
        corruptedIds: [],
        error: errorMessage(error),
      };
    }
    const used = files.usedAttachments(vault);
    const kept = [...corrupt].filter((id) => used.has(id));
    if (kept.length !== known.length || kept.some((id, i) => id !== known[i]))
      await this.local.set(STORAGE_KEYS.corruptFiles, kept);
    return outcome;
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

  private requireVault(): p2p.LocalVault {
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
    const blob = await seal(
      fromBase64(this.requireKeys().vaultKey),
      utf8(serializeVault(this.requireVault())),
      LOCAL_VAULT_AAD,
    );
    await this.local.set(STORAGE_KEYS.vault, blob);
    await this.touch();
  }

  private async startSession(
    vaultKey: Uint8Array,
    vault: p2p.LocalVault,
    account: Account,
  ): Promise<void> {
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

  private async loadVault(vaultKey: Uint8Array): Promise<p2p.LocalVault> {
    const blob = await this.local.get<string>(STORAGE_KEYS.vault);
    if (!blob) return p2p.emptyVault();
    return deserializeVault(fromUtf8(await open(vaultKey, blob, LOCAL_VAULT_AAD)));
  }
}
