import {
  fromBase64,
  p2p,
  randomBytes,
  sameBytes,
  toBase64,
  type KdfParams,
} from "@passholder/core";
import type { PhoneClient } from "../phone-client.ts";
import { answeredFirst, pickPhone, requirePhoneUrls, withLearned } from "../phone-urls.ts";
import type { PinStore } from "../pin-store.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import {
  identityOf,
  opensStaticKey,
  sealStaticKey,
  unwrapWithPassword,
  type Account,
  type AccountStore,
} from "./account.ts";
import {
  ALREADY_PAIRED,
  deviceNameMessage,
  inUserTerms,
  NO_PENDING_PAIRING,
  otherVaultMessage,
  PairedButSyncFailed,
  pairingExpiredMessage,
  PHONE_HAS_OTHER_PASSWORD,
  PHONE_WAITS_FOR_RESTORE,
  WRONG_PASSWORD,
} from "./messages.ts";
import type { VaultSession } from "./session.ts";
import type { SyncResult, VaultSync } from "./sync.ts";

/** How long a pairing waits for the master password before it counts as abandoned (a new code is needed). */
export const PAIRING_PENDING_MS = 10 * 60_000;

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

/** What the connect screen shows while a pairing waits for the master password. */
export interface PendingPairingInfo {
  phoneName: string;
  /** This browser's name, as the phone already lists it in "Urządzenia". */
  deviceName: string;
  /** The addresses the account will start with (typed, then learned from the phone): Chrome must allow each. */
  phoneUrls: string[];
}

/** What repair() did: paired with a phone that has the vault, or restored an empty one; and what its sync skipped. */
export interface RepairResult extends SyncResult {
  mode: "paired" | "restored";
}

/** The vault this browser has, opened with the password it knows. */
interface LocalCopy {
  key: Uint8Array;
  vault: p2p.LocalVault;
}

/** The vault key and vault repair() goes on with, and the wrapping of that key to keep in the account. */
interface RepairedVault extends LocalCopy {
  kdf: KdfParams;
  wrappedVaultKey: string;
}

export interface PairingDeps {
  /** chrome.storage.session: the pending pairing. */
  session: KeyValueStore;
  accounts: AccountStore;
  vaultSession: VaultSession;
  pin: PinStore;
  sync: VaultSync;
  makeClient: (url: string) => PhoneClient;
  now: () => number;
}

/** Pairing a new browser with the phone (pairStart, pairFinish) and pairing this one again (repair). */
export class VaultPairing {
  constructor(private readonly deps: PairingDeps) {}

  /**
   * First step of pairing a new browser: /pair/hello, start and finish with the code the phone shows.
   * The result (with this browser's new static key) waits in session storage for pairFinish.
   */
  async start(urls: readonly string[], code: string, deviceName: string): Promise<void> {
    const typed = requirePhoneUrls(urls);
    const name = deviceName.trim();
    if (name.length < 1 || name.length > p2p.MAX_DEVICE_NAME_LENGTH)
      throw new Error(deviceNameMessage(p2p.MAX_DEVICE_NAME_LENGTH));
    if (await this.deps.accounts.get()) throw new Error(ALREADY_PAIRED);
    const { url: baseUrl, client } = await pickPhone(typed, this.deps.makeClient);
    // pairWithPhone refuses restore mode too, but only with a short message; this one says what to do.
    if ((await this.phoneMode(baseUrl, client)) === "restore")
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
      urls: answeredFirst(baseUrl, typed),
      createdAt: this.deps.now(),
      deviceId: identity.deviceId,
      deviceName: name,
      staticPrivateKey: toBase64(staticKey.privateKey),
      staticPublicKey: identity.staticPublicKey,
      phone: res.phone,
      vaultInfo: res.vaultInfo,
    };
    await this.deps.session.set(STORAGE_KEYS.pendingPairing, pending);
  }

  async pendingInfo(): Promise<PendingPairingInfo | undefined> {
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
  async cancel(): Promise<string | undefined> {
    const pending = await this.loadPending();
    await this.forgetPending();
    return pending?.deviceName;
  }

  forgetPending(): Promise<void> {
    return this.deps.session.remove(STORAGE_KEYS.pendingPairing);
  }

  /**
   * Second step: the master password opens the phone's vault key. A wrong one leaves the pairing in session
   * storage, so it can be typed again without a new code. Then the account is saved and the first sync runs.
   */
  async finish(masterPassword: string): Promise<SyncResult> {
    const stored = await this.deps.session.get<PendingPairing>(STORAGE_KEYS.pendingPairing);
    const pending = await this.loadPending();
    if (!pending) {
      // Expired just now: say so, and name the device the phone still lists.
      if (stored && typeof stored.deviceName === "string")
        throw new Error(pairingExpiredMessage(stored.deviceName));
      throw new Error(NO_PENDING_PAIRING);
    }
    const { kdf, wrappedVaultKey } = pending.vaultInfo;
    const vaultKey = await unwrapWithPassword(masterPassword, kdf, wrappedVaultKey);
    const account: Account = {
      phoneUrls: withLearned(pending.urls, pending.vaultInfo.addresses),
      lastPhoneUrl: pending.url,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      phone: pending.phone,
      kdf,
      wrappedVaultKey,
      sealedStaticKey: await sealStaticKey(vaultKey, fromBase64(pending.staticPrivateKey)),
      staticPublicKey: pending.staticPublicKey,
    };
    const vault = p2p.emptyVault();
    p2p.applyVaultInfo(vault, pending.vaultInfo);
    await this.deps.pin.disable();
    await this.deps.accounts.save(account);
    await this.deps.vaultSession.start(vaultKey, vault, account);
    await this.forgetPending();
    return this.firstSync("paired");
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
    urls: readonly string[],
    code: string,
    masterPassword: string,
  ): Promise<RepairResult> {
    const account = await this.deps.accounts.require();
    const typed = requirePhoneUrls(urls);
    const local = await this.localCopy(account, masterPassword);
    const { url: baseUrl, client } = await pickPhone(typed, this.deps.makeClient);
    // Only this browser's vault can restore the phone, and the password does not open it.
    if (!local && (await this.phoneMode(baseUrl, client)) === "restore")
      throw new Error(WRONG_PASSWORD);
    // In pair mode pairWithPhone does not send `restore`: the phone keeps its own vault.
    const restore = local && restoreInfo(account, local.vault);
    const res = await inUserTerms(() =>
      p2p.pairWithPhone({
        baseUrl,
        code,
        identity: identityOf(account),
        post: client.post,
        restore,
      }),
    );
    let repaired: RepairedVault;
    if (res.mode === "pair") {
      repaired = await this.adoptPhoneVault(account, masterPassword, res.vaultInfo, local);
    } else {
      if (!local) throw new Error(WRONG_PASSWORD);
      repaired = { ...local, kdf: account.kdf, wrappedVaultKey: account.wrappedVaultKey };
    }
    p2p.applyVaultInfo(repaired.vault, res.vaultInfo);
    const updated: Account = {
      ...account,
      phoneUrls: withLearned(answeredFirst(baseUrl, typed), res.vaultInfo.addresses),
      lastPhoneUrl: baseUrl,
      phone: res.phone,
      kdf: repaired.kdf,
      wrappedVaultKey: repaired.wrappedVaultKey,
    };
    if (updated.wrappedVaultKey !== account.wrappedVaultKey) await this.deps.pin.disable();
    await this.deps.accounts.save(updated);
    await this.deps.vaultSession.start(repaired.key, repaired.vault, updated);
    const mode = res.mode === "pair" ? "paired" : "restored";
    const { skipped, files } = await this.firstSync(mode);
    return { mode, skipped, files };
  }

  /** This browser's vault, when the password is the one this browser knows; otherwise undefined. */
  private async localCopy(
    account: Account,
    masterPassword: string,
  ): Promise<LocalCopy | undefined> {
    const key = await unwrapWithPassword(
      masterPassword,
      account.kdf,
      account.wrappedVaultKey,
    ).catch(() => undefined);
    return key && { key, vault: await this.deps.vaultSession.loadVault(key) };
  }

  /**
   * A phone in pair mode keeps its vault: the password must open the phone's copy of the vault key, and that key
   * must be this browser's (the same as the local copy's, or opening the sealed static key). The phone's wrapping
   * is current then (perhaps a new master password).
   */
  private async adoptPhoneVault(
    account: Account,
    masterPassword: string,
    info: p2p.VaultInfo,
    local: LocalCopy | undefined,
  ): Promise<RepairedVault> {
    const phoneKey = await unwrapWithPassword(masterPassword, info.kdf, info.wrappedVaultKey).catch(
      () => undefined,
    );
    if (!phoneKey) throw new Error(local ? PHONE_HAS_OTHER_PASSWORD : WRONG_PASSWORD);
    const sameVault = local
      ? sameBytes(phoneKey, local.key)
      : await opensStaticKey(phoneKey, account);
    if (!sameVault) throw new Error(otherVaultMessage(account.deviceName));
    return {
      key: phoneKey,
      vault: local?.vault ?? (await this.deps.vaultSession.loadVault(phoneKey)),
      kdf: info.kdf,
      wrappedVaultKey: info.wrappedVaultKey,
    };
  }

  private async phoneMode(baseUrl: string, client: PhoneClient): Promise<"pair" | "restore"> {
    return (await inUserTerms(() => p2p.phoneHello(baseUrl, client.post))).mode;
  }

  /** The sync right after a pairing was saved: its failure must not read as a failed pairing. */
  private async firstSync(mode: "paired" | "restored"): Promise<SyncResult> {
    try {
      return await this.deps.sync.sync();
    } catch (error) {
      throw new PairedButSyncFailed(mode, error);
    }
  }

  /** The pending pairing, unless it has expired (then it is removed). */
  private async loadPending(): Promise<PendingPairing | undefined> {
    const pending = await this.deps.session.get<PendingPairing>(STORAGE_KEYS.pendingPairing);
    if (!pending) return undefined;
    if (this.pendingExpired(pending)) {
      await this.forgetPending();
      return undefined;
    }
    return pending;
  }

  /** Older than PAIRING_PENDING_MS, or from the future (the clock moved back): either way not to be trusted. */
  private pendingExpired(pending: PendingPairing): boolean {
    if (typeof pending.createdAt !== "number") return true;
    const age = this.deps.now() - pending.createdAt;
    return age < 0 || age >= PAIRING_PENDING_MS;
  }
}

/** What repair() sends to a phone waiting for "Odtwórz z wtyczki": this browser's vault. */
function restoreInfo(account: Account, vault: p2p.LocalVault): p2p.VaultInfo {
  return {
    // The phone ignores epoch and addresses of a restore, but they must be well formed.
    epoch: vault.epoch ?? toBase64(randomBytes(16)),
    kdf: account.kdf,
    wrappedVaultKey: account.wrappedVaultKey,
    addresses: [],
  };
}
