import {
  createPinLock,
  INVALID_PIN,
  invalidPinMessage,
  isLongPin,
  isValidPin,
  MAX_PIN_ATTEMPTS,
  openPinLock,
  WrongPinError,
  type PinLock,
  type UnlockKeys,
} from "./pin-lock.ts";
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";

/** Whether unlocking with a PIN is on, and how. */
export interface PinStatus {
  /** True if the PIN is kept on disk and works after a browser restart. */
  rememberedAfterRestart: boolean;
  attemptsLeft: number;
}

/** What unlock() found out besides the keys. */
export interface PinUnlockResult {
  keys: UnlockKeys;
  /**
   * The PIN was kept on disk but is short (set before long PINs were required for that). It has been
   * moved to session storage: it works until the browser closes, then the master password is needed.
   */
  movedToMemory: boolean;
}

/**
 * Where the PinLock is kept and how wrong attempts are counted. pin-lock.ts does the cryptography;
 * this class only decides which storage area holds the lock and keeps failedAttempts up to date.
 * VaultStore uses it for unlockWithPin, enablePin, disablePin and pinStatus.
 */
export class PinStore {
  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
  ) {}

  /** undefined when the PIN is off. */
  async status(): Promise<PinStatus | undefined> {
    const found = await this.find();
    if (!found) return undefined;
    return {
      rememberedAfterRestart: found.area === this.local,
      attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - found.lock.failedAttempts),
    };
  }

  /**
   * Wraps keys under the PIN. By default the lock is kept in session storage, which Chrome holds in memory
   * only, so after a browser restart the master password is needed. With rememberAfterRestart it goes to
   * local storage, on disk, where a copy can be guessed offline: that needs a long PIN (isLongPin).
   */
  async enable(pin: string, keys: UnlockKeys, rememberAfterRestart: boolean): Promise<void> {
    if (!isValidPin(pin, rememberAfterRestart)) throw new Error(invalidPinMessage(rememberAfterRestart));
    const lock = await createPinLock(pin, keys);
    await this.disable();
    await (rememberAfterRestart ? this.local : this.session).set(STORAGE_KEYS.pinLock, lock);
  }

  async disable(): Promise<void> {
    await this.session.remove(STORAGE_KEYS.pinLock);
    await this.local.remove(STORAGE_KEYS.pinLock);
  }

  /**
   * The keys wrapped under this PIN. Every wrong PIN counts; after MAX_PIN_ATTEMPTS in a row the PIN is
   * deleted and only the master password works. A PIN of the wrong shape is refused without counting.
   */
  async unlock(pin: string): Promise<PinUnlockResult> {
    if (!isValidPin(pin)) throw new Error(INVALID_PIN);
    const found = await this.find();
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
        await this.disable();
        throw new Error("Zły PIN. To była ostatnia próba: PIN został wyłączony, odblokuj hasłem głównym.");
      }
      throw new Error(`Zły PIN. Pozostało prób: ${MAX_PIN_ATTEMPTS - attempts}.`);
    }
    const reset: PinLock = { ...lock, failedAttempts: 0 };
    // A short PIN on disk (from before S4 was fixed): keep it only in memory from now on.
    if (area === this.local && !isLongPin(pin)) {
      await this.session.set(STORAGE_KEYS.pinLock, reset);
      await this.local.remove(STORAGE_KEYS.pinLock);
      return { keys, movedToMemory: true };
    }
    await area.set(STORAGE_KEYS.pinLock, reset);
    return { keys, movedToMemory: false };
  }

  /** After an unlock with the master password the count of wrong PINs starts again. */
  async resetAttempts(): Promise<void> {
    const found = await this.find();
    if (found && found.lock.failedAttempts > 0) {
      await found.area.set(STORAGE_KEYS.pinLock, { ...found.lock, failedAttempts: 0 } satisfies PinLock);
    }
  }

  /** Session storage first: enable() keeps the PIN in only one of the two. */
  private async find(): Promise<{ lock: PinLock; area: KeyValueStore } | undefined> {
    for (const area of [this.session, this.local]) {
      const lock = await area.get<PinLock>(STORAGE_KEYS.pinLock);
      if (lock) return { lock, area };
    }
    return undefined;
  }
}
