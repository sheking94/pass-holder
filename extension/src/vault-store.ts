import { fromBase64, toBase64, type p2p } from "@passholder/core";
import * as files from "@passholder/core/files";
import { PhoneClient } from "./phone-client.ts";
import { invalidPinMessage, isValidPin } from "./pin-lock.ts";
import { PinStore, type PinStatus } from "./pin-store.ts";
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";
import { AccountStore, unwrapWithPassword, type Account } from "./vault/account.ts";
import { VaultEntries } from "./vault/entries.ts";
import { VaultFiles } from "./vault/files.ts";
import type { StoredEntry } from "./vault/local-vault.ts";
import { UnsyncedChanges, WRONG_PASSWORD } from "./vault/messages.ts";
import { VaultPairing, type PendingPairingInfo, type RepairResult } from "./vault/pairing.ts";
import { VaultSession } from "./vault/session.ts";
import { VaultSync, type FileProgress, type SyncResult } from "./vault/sync.ts";
import {
  VaultTransfer,
  type ArchiveExport,
  type ArchiveImport,
  type ImportResult,
} from "./vault/transfer.ts";

export { chromeStore, memoryStore, STORAGE_KEYS, type KeyValueStore } from "./storage.ts";
export type { PinStatus } from "./pin-store.ts";
export type { Account } from "./vault/account.ts";
export type { FilesOutcome } from "./vault/files.ts";
export { LOCAL_VAULT_AAD, type StoredEntry } from "./vault/local-vault.ts";
export {
  orphanDeviceNote,
  otherVaultMessage,
  PairedButSyncFailed,
  PAIRING_EXPIRED,
  pairingCancelledMessage,
  pairingExpiredMessage,
  PHONE_WAITS_FOR_RESTORE,
  UnsyncedChanges,
} from "./vault/messages.ts";
export { PAIRING_PENDING_MS, type PendingPairingInfo, type RepairResult } from "./vault/pairing.ts";
export { ACTIVITY_WRITE_INTERVAL_MS, AUTO_LOCK_MS } from "./vault/session.ts";
export type { SyncResult } from "./vault/sync.ts";
export type { ImportResult } from "./vault/transfer.ts";

/** What a VaultStore works with. Only the two storage areas are required; the rest has defaults for tests. */
export interface VaultStoreOptions {
  /** chrome.storage.local: the account, the encrypted vault, a remembered PIN. */
  local: KeyValueStore;
  /** chrome.storage.session: the session keys, a pending pairing, a PIN kept until the browser closes. */
  session: KeyValueStore;
  makeClient?: (url: string) => PhoneClient;
  now?: () => number;
  /** Whether Chrome lets this page reach the address (host permission); sync skips those it does not. */
  canReach?: (url: string) => Promise<boolean>;
  /** Encrypted chunks of attachments (IndexedDB in the extension). */
  fileStore?: files.LocalFileStore;
}

/**
 * Everything the popup does with the vault, as one object. The vault is encrypted with the vault key on disk too,
 * so the extension works offline and only talks to the phone when you sync. Every change (upsert, delete, sync)
 * is saved to disk before the method returns.
 *
 * A thin facade over the parts in vault/: VaultSession (unlocked state and auto-lock), AccountStore, VaultEntries,
 * VaultFiles, VaultTransfer (import and export), VaultSync and VaultPairing. What is left here needs several of
 * them: unlocking (password or PIN), the PIN settings and disconnecting.
 */
export class VaultStore {
  private readonly local: KeyValueStore;
  private readonly session: KeyValueStore;
  private readonly pin: PinStore;
  private readonly accounts: AccountStore;
  private readonly vaultSession: VaultSession;
  private readonly entries: VaultEntries;
  private readonly files: VaultFiles;
  private readonly transfer: VaultTransfer;
  private readonly syncer: VaultSync;
  private readonly pairing: VaultPairing;

  constructor(options: VaultStoreOptions) {
    const {
      local,
      session,
      makeClient = (url) => new PhoneClient(url),
      now = Date.now,
      canReach = async () => true,
      fileStore = new files.MemoryLocalFileStore(),
    } = options;
    this.local = local;
    this.session = session;
    this.pin = new PinStore(local, session);
    this.accounts = new AccountStore(local);
    this.vaultSession = new VaultSession(local, session, now);
    this.files = new VaultFiles(this.vaultSession, local, fileStore);
    this.entries = new VaultEntries(this.vaultSession, this.files);
    this.transfer = new VaultTransfer(this.vaultSession, this.entries, this.files);
    this.syncer = new VaultSync(this.vaultSession, this.accounts, this.files, makeClient, canReach);
    this.pairing = new VaultPairing({
      session,
      accounts: this.accounts,
      vaultSession: this.vaultSession,
      pin: this.pin,
      sync: this.syncer,
      makeClient,
      now,
    });
  }

  // Account and addresses

  getAccount(): Promise<Account | undefined> {
    return this.accounts.get();
  }

  /** See AccountStore.setPhoneUrls. */
  setPhoneUrls(phoneUrls: readonly string[]): Promise<void> {
    return this.accounts.setPhoneUrls(phoneUrls);
  }

  // Entries

  /** Live entries of one type, sorted by name (Polish collation). */
  listEntries(type: p2p.EntryType): StoredEntry[] {
    return this.entries.list(type);
  }

  /** A live entry of any type. */
  getEntry(id: string): StoredEntry | undefined {
    return this.entries.get(id);
  }

  /** See VaultEntries.put. */
  putEntry(
    id: string,
    content: p2p.EntryContent,
    newFiles: readonly files.EncryptedFile[] = [],
  ): Promise<void> {
    return this.entries.put(id, content, newFiles);
  }

  delete(id: string): Promise<void> {
    return this.entries.delete(id);
  }

  /** Number of local changes the phone has not seen yet. */
  pendingCount(): number {
    return this.entries.pendingCount();
  }

  /** Content of all live entries of every type (no `v` or `hlc`), for export. */
  allContents(): p2p.EntryContent[] {
    return this.entries.allContents();
  }

  // Files

  /** See VaultFiles.status. */
  fileStatus(a: files.Attachment): Promise<"ready" | "waiting" | "corrupted"> {
    return this.files.status(a);
  }

  /** See VaultFiles.uploaded. */
  fileUploaded(a: files.Attachment): Promise<boolean> {
    return this.files.uploaded(a);
  }

  /** Decrypts a local file for download; only while unlocked. Nothing decrypted is kept. */
  readFile(a: files.Attachment): Promise<Uint8Array> {
    return this.files.read(a);
  }

  // Import and export

  /** See VaultTransfer.importContents. */
  importContents(
    entries: readonly p2p.EntryContent[],
    newId?: () => string,
  ): Promise<ImportResult> {
    return this.transfer.importContents(entries, newId);
  }

  /** See VaultTransfer.exportArchive. */
  exportArchive(): Promise<ArchiveExport> {
    return this.transfer.exportArchive();
  }

  /** See VaultTransfer.importArchive. */
  importArchive(bytes: Uint8Array): Promise<ArchiveImport> {
    return this.transfer.importArchive(bytes);
  }

  // Pairing and sync

  /** See VaultPairing.start. */
  pairStart(urls: readonly string[], code: string, deviceName: string): Promise<void> {
    return this.pairing.start(urls, code, deviceName);
  }

  /** A pairing waits for the master password (pairStart succeeded, pairFinish not yet). */
  async hasPendingPairing(): Promise<boolean> {
    return (await this.pairing.pendingInfo()) !== undefined;
  }

  pendingPairing(): Promise<PendingPairingInfo | undefined> {
    return this.pairing.pendingInfo();
  }

  /** See VaultPairing.cancel. */
  cancelPairing(): Promise<string | undefined> {
    return this.pairing.cancel();
  }

  /** See VaultPairing.finish. */
  pairFinish(masterPassword: string): Promise<SyncResult> {
    return this.pairing.finish(masterPassword);
  }

  /** See VaultPairing.repair. */
  repair(urls: readonly string[], code: string, masterPassword: string): Promise<RepairResult> {
    return this.pairing.repair(urls, code, masterPassword);
  }

  /** See VaultSync.sync. */
  sync(onFileProgress?: FileProgress): Promise<SyncResult> {
    return this.syncer.sync(onFileProgress);
  }

  // Unlocking and auto-lock

  isUnlocked(): boolean {
    return this.vaultSession.isUnlocked();
  }

  /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
  async unlock(masterPassword: string): Promise<void> {
    const account = await this.accounts.require();
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    await this.vaultSession.start(vaultKey, await this.vaultSession.loadVault(vaultKey), account);
    await this.pin.resetAttempts();
  }

  /**
   * Checks the master password again while unlocked, before a plain-text export (security review V3-N6): someone
   * at an unlocked browser cannot take the whole vault in one file without knowing it. Throws "Złe hasło główne"
   * for a password that does not open this vault, and LOCKED when the vault is locked.
   */
  async confirmMasterPassword(masterPassword: string): Promise<void> {
    const keys = this.vaultSession.requireKeys();
    const account = await this.accounts.require();
    const vaultKey = await unwrapWithPassword(masterPassword, account.kdf, account.wrappedVaultKey);
    if (toBase64(vaultKey) !== keys.vaultKey) throw new Error(WRONG_PASSWORD);
  }

  /**
   * Works offline like unlock(), but with the PIN set in enablePin(). Every wrong PIN counts; after
   * MAX_PIN_ATTEMPTS in a row the PIN is deleted and only the master password works (see PinStore).
   */
  async unlockWithPin(pin: string): Promise<{ movedToMemory: boolean }> {
    const account = await this.accounts.require();
    const { keys, movedToMemory } = await this.pin.unlock(pin);
    const vault = await this.vaultSession.loadVault(keys.vaultKey);
    await this.vaultSession.start(keys.vaultKey, vault, account);
    return { movedToMemory };
  }

  /** See VaultSession.resume. */
  async resume(options: { touch?: boolean } = {}): Promise<boolean> {
    return this.vaultSession.resume(await this.accounts.get(), options);
  }

  /** See VaultSession.lockIfIdle. */
  lockIfIdle(): Promise<boolean> {
    return this.vaultSession.lockIfIdle();
  }

  /** See VaultSession.noteActivity. */
  noteActivity(): Promise<void> {
    return this.vaultSession.noteActivity();
  }

  /** When the vault locks unless the user does something; undefined while locked. */
  unlockedUntil(): number | undefined {
    return this.vaultSession.unlockedUntil();
  }

  lock(): Promise<void> {
    return this.vaultSession.lock();
  }

  // PIN

  /** undefined when the PIN is off. */
  pinStatus(): Promise<PinStatus | undefined> {
    return this.pin.status();
  }

  /** Turns on unlocking with a PIN (needs an unlocked vault). See PinStore.enable for where it is kept. */
  async enablePin(pin: string, rememberAfterRestart: boolean): Promise<void> {
    // Before requireKeys(): a PIN of the wrong shape is reported as such even while locked.
    if (!isValidPin(pin, rememberAfterRestart))
      throw new Error(invalidPinMessage(rememberAfterRestart));
    const keys = this.vaultSession.requireKeys();
    await this.pin.enable(pin, { vaultKey: fromBase64(keys.vaultKey) }, rememberAfterRestart);
  }

  disablePin(): Promise<void> {
    return this.pin.disable();
  }

  // Disconnect

  /**
   * Forgets this browser's account, PIN, local copy, an unfinished pairing and the save-question lists. The phone
   * keeps what it has seen, but local changes it has not are lost: while unlocked, that is refused
   * (UnsyncedChanges) unless `force` says the user confirmed it. While locked they cannot be counted; the screen
   * warns instead.
   */
  async disconnect(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && this.isUnlocked()) {
      const count = this.pendingCount();
      if (count > 0) throw new UnsyncedChanges(count);
    }
    await this.lock();
    await this.disablePin();
    await this.pairing.forgetPending();
    // Security review V3-I3: the hosts never to ask about and the unanswered save questions belong to this vault too.
    await this.session.remove(STORAGE_KEYS.saveCandidates);
    await this.local.remove(STORAGE_KEYS.saveNever);
    await this.accounts.remove();
    await this.local.remove(STORAGE_KEYS.vault);
    await this.files.removeAll();
  }
}
