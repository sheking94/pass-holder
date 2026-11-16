import {
  deriveKeys,
  fromBase64,
  MemorySyncStore,
  MIN_KDF,
  newKdfParams,
  newVaultKey,
  p2p,
  randomBytes,
  toBase64,
  unwrapVaultKey,
  utf8,
  wrapVaultKey,
  type KdfParams,
  type SyncStore,
} from "@passholder/core";
import * as files from "@passholder/core/files";
import { PhoneClient } from "../src/phone-client.ts";
import { memoryStore, VaultStore } from "../src/vault-store.ts";

export const CODE = "12345678";
export const PASSWORD = "Zażółć gęślą jaźń 2026";
/** The cheapest KDF the extension accepts, so the tests do not spend minutes in Argon2id. */
export const TEST_KDF = (): KdfParams => ({ ...newKdfParams(), ...MIN_KDF });

type Reply = { status: number; body: unknown };
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

/**
 * A phone in sync mode, as seen over HTTP: the pairing routes of the protocol table (real CPace, responder)
 * in front of the reference P2pHost for handshake and sync.
 */
export class FakePhone {
  readonly staticKey = p2p.generateKeyPair();
  readonly identity: p2p.DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    name: "Telefon",
    staticPublicKey: toBase64(this.staticKey.publicKey),
  };
  readonly epoch = toBase64(randomBytes(16));
  readonly devices: p2p.PairedDevice[] = [];
  readonly calls: string[] = [];
  readonly host: p2p.P2pHost;
  /** The phone's encrypted file chunks (the host side of /p2p/v2/file). */
  readonly files = new files.MemoryFileStore();
  /** false: an older phone app that does not know the file path (answers 404 "not found"). */
  fileSupport = true;
  /** When set, the n-th file request from now (1 = the next one) fails once with 500; then it is cleared. */
  failFileRequest: number | undefined;
  addresses: string[];
  /** undefined while the phone waits for "Odtwórz z wtyczki". */
  kdf: KdfParams | undefined;
  wrappedVaultKey: string | undefined;
  /** The phone's own copy, only to put entries on it in tests. */
  vaultKey: Uint8Array | undefined;
  /** What a restoring extension sent in pairing. */
  receivedVaultInfo: p2p.VaultInfo | undefined;
  private offer: { code: string; sid: string; mode: p2p.PhoneMode } | undefined;
  /** Between /start and /finish: the pairing key and the offer it came from. */
  private pairKey: Uint8Array | undefined;
  private pendingSid: string | undefined;
  private pendingMode: p2p.PhoneMode | undefined;
  private readonly writer = p2p.emptyVaultV2();
  private readonly writerClock = new p2p.HlcClock("phone-writer");

  private constructor(
    readonly store: SyncStore,
    addresses: string[],
  ) {
    this.addresses = addresses;
    this.host = new p2p.P2pHost({
      staticKey: this.staticKey,
      devices: () => this.devices,
      store,
      epoch: this.epoch,
      addresses: () => this.addresses,
      files: this.files,
    });
  }

  /** A phone with its own vault (vault key wrapped under password). */
  static async withVault(password = PASSWORD, addresses: string[] = []): Promise<FakePhone> {
    const phone = new FakePhone(new MemorySyncStore(), addresses);
    phone.kdf = TEST_KDF();
    phone.vaultKey = newVaultKey();
    phone.wrappedVaultKey = await wrapVaultKey(
      (await deriveKeys(password, phone.kdf)).encKey,
      phone.vaultKey,
    );
    return phone;
  }

  /** A phone without a vault, waiting to be restored from an extension. */
  static waitingForRestore(addresses: string[] = []): FakePhone {
    return new FakePhone(new MemorySyncStore(), addresses);
  }

  /** "Dodaj wtyczkę" (or "Odtwórz z wtyczki" when there is no vault yet). */
  offerPairing(code = CODE): void {
    this.offer = { code, sid: toBase64(randomBytes(16)), mode: this.kdf ? "pair" : "restore" };
  }

  /** Adds or changes an entry on the phone, as if typed into the app (its clock is the real time). */
  async addEntry(id: string, name: string, password = "p"): Promise<void> {
    await this.syncWriter();
    const login = p2p.emptyLogin(name);
    await this.addContent(id, { ...login, fields: { ...login.fields, username: "u", password } });
  }

  /** Adds or changes an entry of any type on the phone. */
  async addContent(id: string, content: p2p.EntryContentV3): Promise<void> {
    await this.syncWriter();
    p2p.upsertEntryV2(this.writer, this.writerClock, id, content);
    await this.syncWriter();
  }

  /** The decrypted content of a live entry on the phone. */
  async entryData(id: string, vaultKey = this.vaultKey!): Promise<p2p.EntryDataV3> {
    const record = this.store.listSince(0).find((r) => r.id === id && !r.deleted)!;
    return p2p.parseEntryData(await p2p.decryptPayloadV2(vaultKey, record.id, record.blob));
  }

  /** Passwords of the live entries on the phone by id. */
  async passwords(vaultKey = this.vaultKey!): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const record of this.store.listSince(0)) {
      if (record.deleted) continue;
      const data = p2p.parseEntryData(await p2p.decryptPayloadV2(vaultKey, record.id, record.blob));
      if (data.type === "login") out[record.id] = data.fields.password;
    }
    return out;
  }

  private syncWriter(): Promise<void> {
    return p2p.syncVaultV2(this.writer, this.vaultKey!, this.writerClock, async (request) =>
      p2p.processP2pSync(this.store, this.epoch, this.addresses, request),
    );
  }

  /** Names of the live entries on the phone, decrypted with vaultKey. */
  async entryNames(vaultKey = this.vaultKey!): Promise<string[]> {
    const names: string[] = [];
    for (const record of this.store.listSince(0)) {
      if (record.deleted) continue;
      names.push(
        p2p.parseEntryData(await p2p.decryptPayloadV2(vaultKey, record.id, record.blob)).name,
      );
    }
    return names.sort();
  }

  async handle(path: string, raw: unknown): Promise<Reply> {
    this.calls.push(path);
    const body = (raw ?? {}) as Record<string, unknown>;
    switch (path) {
      case "/p2p/v1/ping":
        return { status: 200, body: { ok: true } };
      case "/p2p/v1/pair/hello":
        return this.offer
          ? { status: 200, body: { sid: this.offer.sid, mode: this.offer.mode } }
          : fail(404, "no pairing");
      case "/p2p/v1/pair/start":
        return this.start(body);
      case "/p2p/v1/pair/finish":
        return this.finish(body);
      case p2p.P2P_FILE_PATH:
        if (!this.fileSupport) return fail(404, "not found");
        if (this.failFileRequest !== undefined && --this.failFileRequest === 0) {
          this.failFileRequest = undefined;
          return fail(500, "internal error");
        }
        return this.host.handle(path, raw);
      default:
        return this.host.handle(path, raw);
    }
  }

  private start(body: Record<string, unknown>): Reply {
    if (typeof body.sid !== "string" || typeof body.message !== "string")
      return fail(400, "malformed request");
    const offer = this.offer;
    if (!offer || body.sid !== offer.sid) return fail(404, "no pairing");
    // One attempt: the offer is gone for every later /start, whatever happens next.
    this.offer = undefined;
    const cpace = p2p.cpaceStart(
      utf8(offer.code),
      p2p.PAIRING_CI,
      fromBase64(offer.sid),
      utf8(this.identity.deviceId),
    );
    try {
      this.pairKey = p2p.pairingKey(
        p2p.cpaceFinish(cpace.state, fromBase64(body.message), "responder"),
      );
    } catch {
      return fail(400, "pairing failed");
    }
    this.pendingSid = offer.sid;
    this.pendingMode = offer.mode;
    return { status: 200, body: { message: toBase64(cpace.message) } };
  }

  private async finish(body: Record<string, unknown>): Promise<Reply> {
    if (typeof body.sid !== "string" || typeof body.identity !== "string")
      return fail(400, "malformed request");
    const key = this.pairKey;
    const mode = this.pendingMode;
    this.pairKey = undefined;
    if (!key || body.sid !== this.pendingSid) return fail(404, "no pairing");
    if ((mode === "restore") !== (typeof body.vaultInfo === "string"))
      return fail(400, "malformed request");
    let identity: p2p.DeviceIdentity;
    try {
      identity = (await p2p.openPairingMessage(
        key,
        "identity",
        "initiator",
        body.identity,
      )) as p2p.DeviceIdentity;
      if (typeof body.vaultInfo === "string") {
        this.receivedVaultInfo = (await p2p.openPairingMessage(
          key,
          "vault-info",
          "initiator",
          body.vaultInfo,
        )) as p2p.VaultInfo;
      }
    } catch {
      return fail(403, "pairing failed");
    }
    if (this.receivedVaultInfo && mode === "restore") {
      this.kdf = this.receivedVaultInfo.kdf;
      this.wrappedVaultKey = this.receivedVaultInfo.wrappedVaultKey;
    }
    const others = this.devices.filter((d) => d.deviceId !== identity.deviceId);
    this.devices.splice(0, this.devices.length, ...others, {
      deviceId: identity.deviceId,
      name: identity.name,
      staticPublicKey: fromBase64(identity.staticPublicKey),
    });
    const info: p2p.VaultInfo = {
      epoch: this.epoch,
      kdf: this.kdf!,
      wrappedVaultKey: this.wrappedVaultKey!,
      addresses: this.addresses,
    };
    return {
      status: 200,
      body: {
        identity: await p2p.sealPairingMessage(key, "identity", "responder", this.identity),
        vaultInfo: await p2p.sealPairingMessage(key, "vault-info", "responder", info),
      },
    };
  }

  /** The vault key as the phone would unwrap it with password (for checks after a restore). */
  /** "Zmień hasło główne" on the phone: the same vault key under a new salt; every paired browser is forgotten. */
  async changePassword(newPassword: string): Promise<void> {
    this.kdf = TEST_KDF();
    this.wrappedVaultKey = await wrapVaultKey(
      (await deriveKeys(newPassword, this.kdf)).encKey,
      this.vaultKey!,
    );
    this.devices.splice(0, this.devices.length);
  }

  async unwrap(password = PASSWORD): Promise<Uint8Array> {
    return unwrapVaultKey((await deriveKeys(password, this.kdf!)).encKey, this.wrappedVaultKey!);
  }
}

/** Where each origin leads: a phone, or "hang" for an address that accepts the request and never answers. */
export type Network = Map<string, FakePhone | "hang">;

/** fetch over the fake network; an origin that is not in it fails like an unreachable host. */
export function networkFetch(network: Network): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const target = network.get(url.origin);
    if (target === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    if (!target) throw new TypeError("fetch failed");
    const reply = await target.handle(url.pathname, JSON.parse(String(init?.body ?? "{}")));
    return Response.json(reply.body, { status: reply.status });
  }) as typeof fetch;
}

/** A browser whose VaultStore reaches the fake network. */
export function newBrowser(
  network: Network,
  now: () => number = Date.now,
  canReach?: (url: string) => Promise<boolean>,
  fileStore: files.LocalFileStore = new files.MemoryLocalFileStore(),
) {
  const local = memoryStore();
  const session = memoryStore();
  const fetchFn = networkFetch(network);
  const makeClient = (url: string) => new PhoneClient(url, fetchFn);
  return {
    local,
    session,
    makeClient,
    files: fileStore,
    store: new VaultStore(local, session, makeClient, now, canReach, fileStore),
  };
}

/** The file phase of a sync that had no attachments to move. */
export const NO_FILES = { uploaded: 0, downloaded: 0, pending: 0, corrupted: [], corruptedIds: [] };

export const PHONE_URL = "http://192.168.1.5:8787";
export const SECOND_URL = "http://100.64.0.7:8787";

/** A phone with a vault at PHONE_URL and a browser paired with it (unlocked). */
export async function pairedBrowser(o: { now?: () => number; phoneAddresses?: string[] } = {}) {
  const phone = await FakePhone.withVault(PASSWORD, o.phoneAddresses ?? [PHONE_URL]);
  const network: Network = new Map([[PHONE_URL, phone]]);
  const browser = newBrowser(network, o.now);
  phone.offerPairing();
  await browser.store.pairStart(PHONE_URL, CODE, "Chrome (Linux)");
  await browser.store.pairFinish(PASSWORD);
  return { phone, network, ...browser };
}

export const names = (store: VaultStore) =>
  store
    .entries()
    .map((e) => e.data.name)
    .sort();
