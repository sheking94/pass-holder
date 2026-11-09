import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64, p2p, seal, utf8 } from "@passholder/core";
import { AUTO_LOCK_MS, LOCAL_VAULT_AAD, STORAGE_KEYS, UnsyncedChanges, VaultStore, type Account } from "../src/vault-store.ts";
import {
  CODE,
  FakePhone,
  names,
  newBrowser,
  pairedBrowser,
  PASSWORD,
  PHONE_URL,
  SECOND_URL,
  type Network,
} from "./fake-phone.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("pairing a new browser with the phone", () => {
  it("pairs with the code, asks for the master password and shows the phone's entries", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    await phone.addEntry("1", "bank.pl");
    const { store, session, local } = newBrowser(new Map([[PHONE_URL, phone]]));
    phone.offerPairing();

    expect(await store.pairStart(PHONE_URL, CODE, "Chrome (Linux)")).toEqual({ needsPassword: true });
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeDefined();
    expect(await store.getAccount()).toBeUndefined();
    expect(phone.devices.map((d) => d.name)).toEqual(["Chrome (Linux)"]);

    await store.pairFinish(PASSWORD);
    expect(names(store)).toEqual(["bank.pl"]);
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
    const account = (await store.getAccount())!;
    expect(account).toMatchObject({ phoneUrls: [PHONE_URL], lastPhoneUrl: PHONE_URL, deviceName: "Chrome (Linux)", phone: phone.identity });
    expect(account.deviceId).toBe(phone.devices[0]!.deviceId);
    // The static private key is on disk only sealed under the vault key.
    expect(fromBase64(account.staticPublicKey)).toEqual(phone.devices[0]!.staticPublicKey);
    expect(Object.keys(account).sort()).toEqual(
      ["deviceId", "deviceName", "kdf", "lastPhoneUrl", "phone", "phoneUrls", "sealedStaticKey", "staticPublicKey", "wrappedVaultKey"],
    );
    expect(await local.get(STORAGE_KEYS.account)).toEqual(account);
  }, 30_000);

  it("keeps the pairing after a wrong master password, so the second try needs no new code (Review Focus 1)", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    await phone.addEntry("1", "bank.pl");
    const { store, local, session, makeClient } = newBrowser(new Map([[PHONE_URL, phone]]));
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");

    await expect(store.pairFinish("wrong password")).rejects.toThrow("Złe hasło główne");
    expect(await store.getAccount()).toBeUndefined();
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeDefined();

    // The popup was closed in between: a new VaultStore on the same storage finishes the pairing.
    const reopened = new VaultStore(local, session, makeClient);
    await reopened.pairFinish(PASSWORD);
    expect(names(reopened)).toEqual(["bank.pl"]);
    expect(phone.calls.filter((c) => c === "/p2p/v1/pair/start")).toHaveLength(1);
  }, 30_000);

  it("pairFinish without a pairing says to pair first", async () => {
    const { store } = newBrowser(new Map());
    await expect(store.pairFinish(PASSWORD)).rejects.toThrow("Najpierw sparuj");
  });

  it("explains a phone that waits for a restore, without spending its code", async () => {
    const phone = FakePhone.waitingForRestore([PHONE_URL]);
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]));
    phone.offerPairing();
    await expect(store.pairStart(PHONE_URL, CODE, "Chrome")).rejects.toThrow("Telefon czeka na odtworzenie sejfu z wtyczki");
    expect(phone.calls).not.toContain("/p2p/v1/pair/start");
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  });

  it("refuses an address that is not an IPv4 address of the phone", async () => {
    const { store } = newBrowser(new Map());
    for (const bad of ["https://192.168.1.5:8787", "http://telefon.local:8787", "http://[::1]:8787", "192.168.1.300"]) {
      await expect(store.pairStart(bad, CODE, "Chrome")).rejects.toThrow("Nieprawidłowy adres telefonu");
    }
  });
});

describe("pairing an existing browser again (repair)", () => {
  it("refuses a phone with another vault and keeps the account and entries (Review Focus 2)", async () => {
    const { store, local } = await pairedBrowser();
    await store.upsert("1", { name: "moje.pl", username: "u", password: "p" });
    await store.sync();

    // Another phone with its own vault, even under the same master password.
    const other = await FakePhone.withVault(PASSWORD, [SECOND_URL]);
    const browser = newBrowser(new Map([[SECOND_URL, other]]));
    const sameStore = new VaultStore(local, browser.session, browser.makeClient);
    await sameStore.unlock(PASSWORD); // saves the vault again (new nonce), so compare from here
    const accountBefore = await local.get(STORAGE_KEYS.account);
    const vaultBefore = await local.get(STORAGE_KEYS.vault);
    other.offerPairing();
    await expect(sameStore.repair(SECOND_URL, CODE, PASSWORD)).rejects.toThrow(
      "To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem. Na nowym telefonie usuń „Chrome (Linux)” z „Urządzenia”.",
    );
    expect(await local.get(STORAGE_KEYS.account)).toEqual(accountBefore);
    expect(await local.get(STORAGE_KEYS.vault)).toEqual(vaultBefore);
    expect(names(sameStore)).toEqual(["moje.pl"]);
  }, 60_000);

  it("pairs with the same vault on a reinstalled phone in pair mode, keeping deviceId and key", async () => {
    const { store, phone, local, session, makeClient } = await pairedBrowser();
    const before = (await store.getAccount())!;
    phone.offerPairing();
    expect(await store.repair(PHONE_URL, CODE, PASSWORD)).toEqual({ mode: "paired", skipped: [] });
    const after = (await store.getAccount())!;
    expect(after.deviceId).toBe(before.deviceId);
    expect(after.staticPublicKey).toBe(before.staticPublicKey);
    expect(phone.devices).toHaveLength(1);
    await new VaultStore(local, session, makeClient).unlock(PASSWORD);
  }, 60_000);

  it("restores a phone from the extension: the phone gets every entry from baseRevision 0", async () => {
    const { store, local, session } = await pairedBrowser();
    for (const name of ["a.pl", "b.pl", "c.pl"]) await store.upsert(name, { name, username: "u", password: "p" });
    await store.sync(); // the entries now have revisions on the old phone
    expect(store.entry("a.pl")!.dirty).toBe(false);
    const vaultKey = fromBase64((await session.get<{ vaultKey: string }>(STORAGE_KEYS.sessionKeys))!.vaultKey);
    const before = (await store.getAccount())!;

    // The phone was lost; a new one waits for "Odtwórz z wtyczki" at another address.
    const fresh = FakePhone.waitingForRestore([SECOND_URL]);
    const browser = newBrowser(new Map([[SECOND_URL, fresh]]));
    const sameStore = new VaultStore(local, session, browser.makeClient);
    fresh.offerPairing();
    expect(await sameStore.repair(SECOND_URL, CODE, PASSWORD)).toEqual({ mode: "restored", skipped: [] });

    expect(fresh.receivedVaultInfo).toMatchObject({ kdf: before.kdf, wrappedVaultKey: before.wrappedVaultKey });
    // A non-zero baseRevision for an entry the empty phone does not know would be refused with 400.
    expect(await fresh.entryNames(vaultKey)).toEqual(["a.pl", "b.pl", "c.pl"]);
    expect(await fresh.unwrap()).toEqual(vaultKey);
    expect(sameStore.pendingCount()).toBe(0);
    expect((await sameStore.getAccount())!).toMatchObject({
      deviceId: before.deviceId,
      phone: fresh.identity,
      phoneUrls: [SECOND_URL],
      lastPhoneUrl: SECOND_URL,
    });
  }, 60_000);

  it("returns the learned addresses its first sync skipped because Chrome does not allow them (M1)", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL, SECOND_URL]);
    const { store } = newBrowser(new Map([[PHONE_URL, phone]]), Date.now, async (u) => u === PHONE_URL);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    await store.pairFinish(PASSWORD);
    phone.offerPairing();
    expect(await store.repair(PHONE_URL, CODE, PASSWORD)).toEqual({ mode: "paired", skipped: [SECOND_URL] });
  }, 60_000);

  it("checks the master password before spending the phone's code", async () => {
    const { store, phone } = await pairedBrowser();
    phone.offerPairing();
    const callsBefore = phone.calls.length;
    await expect(store.repair(PHONE_URL, CODE, "wrong password")).rejects.toThrow("Złe hasło główne");
    expect(phone.calls.slice(callsBefore)).toEqual([]);
  }, 60_000);
});

describe("syncing with the phone", () => {
  it("tries the next address after 4 s when the first one hangs, and remembers the one that worked (Review Focus 5)", async () => {
    const { store, phone, network } = await pairedBrowser({ phoneAddresses: [] });
    const silent = "http://192.168.1.9:8787";
    network.set(silent, "hang");
    network.set(SECOND_URL, phone);
    await store.setPhoneUrls([silent, SECOND_URL]);
    await store.upsert("1", { name: "bank.pl", username: "u", password: "p" });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const syncing = store.sync().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await syncing;
    vi.useRealTimers();

    expect(store.pendingCount()).toBe(0);
    expect(await phone.entryNames()).toEqual(["bank.pl"]);
    expect((await store.getAccount())!.lastPhoneUrl).toBe(SECOND_URL);
  }, 30_000);

  it("adds IPv4 addresses learned from the phone, keeps typed ones and skips others", async () => {
    const { store, phone } = await pairedBrowser();
    await store.setPhoneUrls([PHONE_URL, "10.0.0.2:8787"]);
    phone.addresses = [PHONE_URL, SECOND_URL, "http://telefon.local:8787", "http://[fd00::1]:8787"];
    await store.sync();
    expect((await store.getAccount())!.phoneUrls).toEqual([PHONE_URL, "http://10.0.0.2:8787", SECOND_URL]);
  }, 30_000);

  it("takes the phone's entries and sends its own both ways", async () => {
    const { store, phone } = await pairedBrowser();
    await phone.addEntry("p1", "z-telefonu.pl");
    await store.upsert("e1", { name: "z-wtyczki.pl", username: "u", password: "p" });
    await store.sync();
    expect(names(store)).toEqual(["z-telefonu.pl", "z-wtyczki.pl"]);
    expect(await phone.entryNames()).toEqual(["z-telefonu.pl", "z-wtyczki.pl"]);
    await store.delete("p1");
    await store.sync();
    expect(await phone.entryNames()).toEqual(["z-wtyczki.pl"]);
  }, 30_000);

  it("keeps addresses another page saved during the sync and adds the learned ones (M7)", async () => {
    const extra = "http://10.0.0.2:8787";
    let duringSync: (() => Promise<void>) | undefined;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    // canReach runs after sync() read the account: a stand-in for another page writing it meanwhile.
    const browser = newBrowser(new Map([[PHONE_URL, phone]]), Date.now, async () => {
      const run = duringSync;
      duringSync = undefined;
      await run?.();
      return true;
    });
    phone.offerPairing();
    await browser.store.pairStart(PHONE_URL, CODE, "Chrome");
    await browser.store.pairFinish(PASSWORD);
    const account = (await browser.store.getAccount())!;
    duringSync = () => browser.local.set(STORAGE_KEYS.account, { ...account, phoneUrls: [PHONE_URL, extra], deviceName: "inna nazwa" });
    phone.addresses = [PHONE_URL, SECOND_URL];
    await browser.store.sync();
    expect(await browser.store.getAccount()).toMatchObject({ phoneUrls: [PHONE_URL, extra, SECOND_URL], lastPhoneUrl: PHONE_URL, deviceName: "inna nazwa" });
  }, 30_000);

  it("does not write the account when another page paired with another phone during the sync (M7)", async () => {
    let duringSync: (() => Promise<void>) | undefined;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const browser = newBrowser(new Map([[PHONE_URL, phone]]), Date.now, async () => {
      const run = duringSync;
      duringSync = undefined;
      await run?.();
      return true;
    });
    phone.offerPairing();
    await browser.store.pairStart(PHONE_URL, CODE, "Chrome");
    await browser.store.pairFinish(PASSWORD);
    const account = (await browser.store.getAccount())!;
    const repaired: Account = { ...account, phone: { ...account.phone, staticPublicKey: "bm93eQ==" }, phoneUrls: [SECOND_URL], lastPhoneUrl: SECOND_URL };
    duringSync = () => browser.local.set(STORAGE_KEYS.account, repaired);
    phone.addresses = [PHONE_URL, "http://10.0.0.3:8787"];
    await browser.store.sync();
    expect(await browser.store.getAccount()).toEqual(repaired);
  }, 30_000);

  it("says the phone does not answer when sync mode is off", async () => {
    const { store, network } = await pairedBrowser();
    network.clear();
    await expect(store.sync()).rejects.toThrow("Telefon nie odpowiada");
  }, 30_000);
});

describe("VaultStore offline", () => {
  it("unlocks from disk without the phone and keeps entries encrypted at rest", async () => {
    const browser = await pairedBrowser();
    await browser.store.upsert("1", { name: "poczta.pl", username: "jan", password: "hunter2" });
    browser.network.clear(); // the phone is out of reach

    await browser.store.lock();
    expect(browser.store.isUnlocked()).toBe(false);
    await expect(browser.store.unlock("wrong")).rejects.toThrow("Złe hasło główne");
    await browser.store.unlock(PASSWORD);
    expect(names(browser.store)).toEqual(["poczta.pl"]);

    const onDisk = JSON.stringify([await browser.local.get(STORAGE_KEYS.account), await browser.local.get(STORAGE_KEYS.vault)]);
    expect(onDisk).not.toMatch(/poczta|hunter2/);
  }, 30_000);

  it("resumes without a password until auto-lock", async () => {
    let clock = 1_000_000;
    const browser = await pairedBrowser({ now: () => clock });

    const reopened = new VaultStore(browser.local, browser.session, browser.makeClient, () => clock);
    expect(await reopened.resume()).toBe(true);

    clock += AUTO_LOCK_MS + 1;
    const later = new VaultStore(browser.local, browser.session, browser.makeClient, () => clock);
    expect(await later.resume()).toBe(false);
    expect(await browser.session.get(STORAGE_KEYS.sessionKeys)).toBeUndefined();
  }, 30_000);

  it("disconnect forgets the account, the local copy and a pending pairing", async () => {
    const browser = await pairedBrowser();
    await browser.session.set(STORAGE_KEYS.pendingPairing, { stale: true });
    await browser.store.disconnect();
    expect(await browser.store.getAccount()).toBeUndefined();
    expect(await browser.local.get(STORAGE_KEYS.vault)).toBeUndefined();
    expect(await browser.session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  }, 30_000);

  it("refuses to disconnect with unsynced changes unless forced, and names how many (I1)", async () => {
    const browser = await pairedBrowser();
    await browser.store.upsert("1", { name: "a.pl", username: "u", password: "p" });
    await browser.store.upsert("2", { name: "b.pl", username: "u", password: "p" });
    const error = await browser.store.disconnect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsyncedChanges);
    expect((error as UnsyncedChanges).count).toBe(2);
    expect((error as Error).message).toBe(
      "Niezsynchronizowane zmiany: 2. Odłączenie usunie je z tej przeglądarki. Najpierw zsynchronizuj albo wyeksportuj sejf do pliku.",
    );
    expect(await browser.store.getAccount()).toBeDefined();
    expect(names(browser.store)).toEqual(["a.pl", "b.pl"]);

    await browser.store.disconnect({ force: true });
    expect(await browser.store.getAccount()).toBeUndefined();
    expect(await browser.local.get(STORAGE_KEYS.vault)).toBeUndefined();
  }, 30_000);

  it("disconnects while locked without counting (the UI warns that changes may be lost)", async () => {
    const browser = await pairedBrowser();
    await browser.store.upsert("1", { name: "a.pl", username: "u", password: "p" });
    await browser.store.lock();
    await browser.store.disconnect();
    expect(await browser.store.getAccount()).toBeUndefined();
  }, 30_000);

  it("does not read the v1 account of the Raspberry Pi version", async () => {
    const { local, store } = newBrowser(new Map() as Network);
    await local.set("account", { serverUrls: ["https://pi.local:8443"] });
    expect(await store.getAccount()).toBeUndefined();
    expect(STORAGE_KEYS).toMatchObject({ account: "accountV2", vault: "vaultV2", pendingPairing: "pendingPairing" });
    const typed: Account | undefined = await store.getAccount();
    expect(typed).toBeUndefined();
  });
});

describe("v3 entries", () => {
  it("names an old entry too large to sync as v3 in Polish", async () => {
    const { store, local, session } = await pairedBrowser();
    const vaultKey = fromBase64((await session.get<{ vaultKey: string }>(STORAGE_KEYS.sessionKeys))!.vaultKey);
    await store.lock();
    const hlc = { ms: 1_700_000_000_000, c: 0, d: "old-browser" };
    const oldVault = {
      epoch: null, lastSyncRevision: 0, addresses: [],
      entries: [{ id: "1", revision: 0, dirty: true, deleted: false, data: { name: "Wielki", username: "u", password: "x".repeat(49_000), hlc } }],
    };
    await local.set(STORAGE_KEYS.vault, await seal(vaultKey, utf8(JSON.stringify(oldVault)), LOCAL_VAULT_AAD));
    await store.unlock(PASSWORD);
    await expect(store.sync()).rejects.toThrow("Wpis „Wielki” jest za duży (ponad 64 KiB) i nie może zostać zsynchronizowany. Skróć go.");
  }, 30_000);

  it("opens vault saved in v2 format", async () => {
    const { store, phone, local, session } = await pairedBrowser();
    const vaultKey = fromBase64((await session.get<{ vaultKey: string }>(STORAGE_KEYS.sessionKeys))!.vaultKey);
    await store.lock();
    // What the previous extension wrote: v2-shaped data (no v, no type).
    const hlc = { ms: 1_700_000_000_000, c: 0, d: "old-browser" };
    const oldVault = {
      epoch: null,
      lastSyncRevision: 0,
      addresses: [],
      entries: [
        { id: "1", revision: 0, dirty: true, deleted: false, data: { name: "stary.pl", username: "jan", password: "tajne", hlc } },
        { id: "2", revision: 3, dirty: false, deleted: true, data: { hlc } },
      ],
    };
    await local.set(STORAGE_KEYS.vault, await seal(vaultKey, utf8(JSON.stringify(oldVault)), LOCAL_VAULT_AAD));

    await store.unlock(PASSWORD);
    expect(store.pendingCount()).toBe(1);
    expect(store.entry("1")).toMatchObject({ dirty: true });
    expect(store.entry("2")).toBeUndefined();
    const tombstone = (store as unknown as { vault: p2p.LocalVaultV2 }).vault.entries.get("2");
    expect(tombstone).toMatchObject({ revision: 3, deleted: true, dirty: false });
    expect(store.entries().map((e) => e.data)).toEqual([{ name: "stary.pl", username: "jan", password: "tajne" }]);
    await store.sync();
    expect(await phone.passwords()).toEqual({ "1": "tajne" });
    expect((await phone.entryData("1")).type).toBe("login");
  }, 30_000);

  it("edit keeps v3 fields", async () => {
    const { store, phone } = await pairedBrowser();
    const login = p2p.emptyLogin("bank.pl");
    await phone.addContent("1", {
      ...login,
      note: "notatka",
      custom: [{ label: "PIN", value: "1234", hidden: true }],
      fields: { username: "jan", password: "old", totp: "JBSWY3DP", urls: ["https://bank.pl"], androidApps: ["pl.bank"] },
    });
    await store.sync();
    expect(store.entry("1")!.data).toEqual({ name: "bank.pl", username: "jan", password: "old" });

    await store.upsert("1", { name: "bank.pl", username: "jan", password: "new" });
    await store.sync();
    const data = await phone.entryData("1");
    expect(data).toMatchObject({
      type: "login",
      name: "bank.pl",
      note: "notatka",
      custom: [{ label: "PIN", value: "1234", hidden: true }],
      fields: { username: "jan", password: "new", totp: "JBSWY3DP", urls: ["https://bank.pl"], androidApps: ["pl.bank"] },
    });
  }, 30_000);

  it("other types are hidden", async () => {
    const { store, phone } = await pairedBrowser();
    const base = { name: "Jan", note: "", custom: [] };
    await phone.addContent("c", {
      ...base,
      type: "contact",
      fields: { firstName: "Jan", lastName: "K", birthDate: "", phones: [], emails: [], addresses: [] },
    });
    await phone.addEntry("l", "login.pl");
    await store.sync();
    expect(names(store)).toEqual(["login.pl"]);
    expect(store.entry("c")).toBeUndefined();
    expect(store.pendingCount()).toBe(0);
  }, 30_000);

  it("refuses to overwrite a live non-login entry with a login", async () => {
    const { store, phone } = await pairedBrowser();
    await phone.addContent("n", { ...p2p.emptyLogin("x"), type: "note", fields: {} });
    await store.sync();
    expect(store.pendingCount()).toBe(0);
    await expect(store.upsert("n", { name: "a", username: "b", password: "c" })).rejects.toThrow("Ten wpis nie jest loginem");
    expect(store.pendingCount()).toBe(0);
    await store.sync();
    expect((await phone.entryData("n")).type).toBe("note");
  }, 30_000);

  it("too large entry", async () => {
    const { store } = await pairedBrowser();
    const big = { name: "big", username: "u", password: "x".repeat(70_000) };
    await expect(store.upsert("1", big)).rejects.toThrow("Wpis jest za duży");
    expect(store.entries()).toEqual([]);
    expect(await store.importContents([{ ...p2p.emptyLogin("big"), note: "x".repeat(70_000) } as p2p.EntryContentV3], () => "2")).toEqual({ added: 0, duplicates: 0, tooLarge: 1 });
    expect(store.entries()).toEqual([]);
  }, 30_000);
});
