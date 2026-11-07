import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64 } from "@passholder/core";
import { AUTO_LOCK_MS, STORAGE_KEYS, VaultStore, type Account } from "../src/vault-store.ts";
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
      "To inny sejf. Wtyczka zostaje połączona z poprzednim telefonem.",
    );
    expect(await local.get(STORAGE_KEYS.account)).toEqual(accountBefore);
    expect(await local.get(STORAGE_KEYS.vault)).toEqual(vaultBefore);
    expect(names(sameStore)).toEqual(["moje.pl"]);
  }, 60_000);

  it("pairs with the same vault on a reinstalled phone in pair mode, keeping deviceId and key", async () => {
    const { store, phone, local, session, makeClient } = await pairedBrowser();
    const before = (await store.getAccount())!;
    phone.offerPairing();
    expect(await store.repair(PHONE_URL, CODE, PASSWORD)).toBe("paired");
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
    expect(store.entry("a.pl")!.revision).toBeGreaterThan(0);
    const vaultKey = fromBase64((await session.get<{ vaultKey: string }>(STORAGE_KEYS.sessionKeys))!.vaultKey);
    const before = (await store.getAccount())!;

    // The phone was lost; a new one waits for "Odtwórz z wtyczki" at another address.
    const fresh = FakePhone.waitingForRestore([SECOND_URL]);
    const browser = newBrowser(new Map([[SECOND_URL, fresh]]));
    const sameStore = new VaultStore(local, session, browser.makeClient);
    fresh.offerPairing();
    expect(await sameStore.repair(SECOND_URL, CODE, PASSWORD)).toBe("restored");

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

  it("does not read the v1 account of the Raspberry Pi version", async () => {
    const { local, store } = newBrowser(new Map() as Network);
    await local.set("account", { serverUrls: ["https://pi.local:8443"] });
    expect(await store.getAccount()).toBeUndefined();
    expect(STORAGE_KEYS).toMatchObject({ account: "accountV2", vault: "vaultV2", pendingPairing: "pendingPairing" });
    const typed: Account | undefined = await store.getAccount();
    expect(typed).toBeUndefined();
  });
});
