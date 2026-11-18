import {
  assertKdfParamsAcceptable,
  deriveKeys,
  open,
  p2p,
  seal,
  unwrapVaultKey,
  type KdfParams,
} from "@passholder/core";
import { requirePhoneUrls } from "../phone-urls.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import { NOT_PAIRED, WRONG_PASSWORD } from "./messages.ts";

const STATIC_KEY_AAD = "passholder/v2/ext-static-key";

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

/** The pairing of this browser with a phone, in chrome.storage.local. */
export class AccountStore {
  constructor(private readonly local: KeyValueStore) {}

  get(): Promise<Account | undefined> {
    return this.local.get<Account>(STORAGE_KEYS.account);
  }

  async require(): Promise<Account> {
    const account = await this.get();
    if (!account) throw new Error(NOT_PAIRED);
    return account;
  }

  save(account: Account): Promise<void> {
    return this.local.set(STORAGE_KEYS.account, account);
  }

  remove(): Promise<void> {
    return this.local.remove(STORAGE_KEYS.account);
  }

  /**
   * Replaces the list of phone addresses. No new pairing is needed: every address leads to the same phone,
   * and the Noise handshake checks its static key on every sync.
   */
  async setPhoneUrls(phoneUrls: readonly string[]): Promise<void> {
    const account = await this.require();
    const urls = requirePhoneUrls(phoneUrls);
    const lastPhoneUrl =
      account.lastPhoneUrl && urls.includes(account.lastPhoneUrl)
        ? account.lastPhoneUrl
        : undefined;
    await this.save({ ...account, phoneUrls: urls, lastPhoneUrl });
  }
}

/** This browser as the phone knows it. */
export function identityOf(account: Account): p2p.DeviceIdentity {
  return {
    deviceId: account.deviceId,
    name: account.deviceName,
    staticPublicKey: account.staticPublicKey,
  };
}

/**
 * Unwraps the vault key; a wrong password (the GCM tag does not verify) becomes "Złe hasło główne".
 * KDF parameters out of bounds (assertKdfParamsAcceptable) are refused before any hashing.
 */
export async function unwrapWithPassword(
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

/** This browser's X25519 private key, sealed for Account.sealedStaticKey. */
export function sealStaticKey(vaultKey: Uint8Array, privateKey: Uint8Array): Promise<string> {
  return seal(vaultKey, privateKey, STATIC_KEY_AAD);
}

export function openStaticKey(vaultKey: Uint8Array, account: Account): Promise<Uint8Array> {
  return open(vaultKey, account.sealedStaticKey, STATIC_KEY_AAD);
}

/** [vaultKey] opens this browser's sealed static key, so it is the key of this browser's vault. */
export async function opensStaticKey(vaultKey: Uint8Array, account: Account): Promise<boolean> {
  try {
    await openStaticKey(vaultKey, account);
    return true;
  } catch {
    return false;
  }
}
