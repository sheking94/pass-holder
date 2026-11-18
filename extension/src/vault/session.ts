import { fromBase64, p2p, toBase64 } from "@passholder/core";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import type { Account } from "./account.ts";
import { openVault, sealVault } from "./local-vault.ts";
import { LOCKED } from "./messages.ts";

export const AUTO_LOCK_MS = 15 * 60_000;

/**
 * Activity (a click, a key) moves the auto-lock deadline, but writes it to session storage at most this
 * often, so typing does not cause a storage write per key.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** Kept in chrome.storage.session (memory only, gone when the browser closes) while unlocked. */
export interface SessionKeys {
  vaultKey: string;
  unlockedUntil: number;
}

/**
 * The unlocked state of one page: the vault in memory, its key and the clock, and the auto-lock deadline
 * shared with the other pages through session storage. Every other part of the vault asks it for these
 * (require*) and gets LOCKED once the 15 minutes have passed. It also reads and writes the encrypted vault.
 */
export class VaultSession {
  private vault: p2p.LocalVault | undefined;
  private keys: SessionKeys | undefined;
  private clock: p2p.HlcClock | undefined;

  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly now: () => number,
  ) {}

  isUnlocked(): boolean {
    return this.vault !== undefined && !this.expired();
  }

  /**
   * `vault` is still the vault of this session. A lock clears it and an unlock loads a new object, so the same
   * object means the same session.
   */
  isCurrent(vault: p2p.LocalVault): boolean {
    return this.keys !== undefined && !this.expired() && this.vault === vault;
  }

  requireVault(): p2p.LocalVault {
    if (!this.vault || this.expired()) throw new Error(LOCKED);
    return this.vault;
  }

  requireKeys(): SessionKeys {
    if (!this.keys || this.expired()) throw new Error(LOCKED);
    return this.keys;
  }

  requireClock(): p2p.HlcClock {
    if (!this.clock || this.expired()) throw new Error(LOCKED);
    return this.clock;
  }

  /** The vault key as bytes; LOCKED when locked. */
  requireVaultKey(): Uint8Array {
    return fromBase64(this.requireKeys().vaultKey);
  }

  /** Unlocks with this key and vault: the 15 minutes start, and the vault is saved (which shares the deadline). */
  async start(vaultKey: Uint8Array, vault: p2p.LocalVault, account: Account): Promise<void> {
    this.vault = vault;
    this.clock = p2p.clockForVault(vault, account.deviceId, this.now);
    this.keys = { vaultKey: toBase64(vaultKey), unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.save();
  }

  /** Writes the vault to disk, sealed with the vault key, and moves the auto-lock deadline. */
  async save(): Promise<void> {
    const blob = await sealVault(this.requireVaultKey(), this.requireVault());
    await this.local.set(STORAGE_KEYS.vault, blob);
    await this.touch();
  }

  /** The vault on disk, opened with this key; an empty vault when there is none yet. */
  async loadVault(vaultKey: Uint8Array): Promise<p2p.LocalVault> {
    const blob = await this.local.get<string>(STORAGE_KEYS.vault);
    if (!blob) return p2p.emptyVault();
    return openVault(vaultKey, blob);
  }

  /** Restores an unlocked state kept in session storage, so reopening the popup needs no password. */
  async resume(account: Account | undefined, options: { touch?: boolean } = {}): Promise<boolean> {
    const keys = await this.session.get<SessionKeys>(STORAGE_KEYS.sessionKeys);
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

  /** The 15 minutes have passed. lockIfIdle() then clears the keys; until it runs nothing may use them. */
  private expired(): boolean {
    return this.keys !== undefined && this.keys.unlockedUntil <= this.now();
  }

  private async touch(): Promise<void> {
    if (!this.keys) return;
    this.keys = { ...this.keys, unlockedUntil: this.now() + AUTO_LOCK_MS };
    await this.session.set(STORAGE_KEYS.sessionKeys, this.keys);
  }
}
