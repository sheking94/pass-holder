import { afterEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS, PAIRING_PENDING_MS, PairedButSyncFailed, VaultStore } from "../src/vault-store.ts";
import { CODE, FakePhone, names, newBrowser, pairedBrowser, PASSWORD, PHONE_URL, SECOND_URL } from "./fake-phone.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("pending pairing as the connect screen sees it", () => {
  it("reports a pending pairing with the phone's name and the addresses to allow, and cancels it", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL, SECOND_URL, "http://telefon.local:8787"]);
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]));
    expect(await store.hasPendingPairing()).toBe(false);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome (Linux)");

    expect(await store.hasPendingPairing()).toBe(true);
    expect(await store.pendingPairing()).toEqual({ phoneName: "Telefon", deviceName: "Chrome (Linux)", phoneUrls: [PHONE_URL, SECOND_URL] });
    // The phone already lists the browser: the screen names it, so the user can remove it there (M6).
    expect(await store.cancelPairing()).toBe("Chrome (Linux)");
    expect(await store.cancelPairing()).toBeUndefined();
    expect(await store.hasPendingPairing()).toBe(false);
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
    await expect(store.pairFinish(PASSWORD)).rejects.toThrow("Najpierw sparuj");
  }, 30_000);

  it("treats a pairing older than 10 minutes as absent and clears it", async () => {
    let clock = 5_000_000;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store, session, local, makeClient } = newBrowser(new Map([[PHONE_URL, phone]]), () => clock);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    expect(PAIRING_PENDING_MS).toBe(10 * 60_000);

    clock += PAIRING_PENDING_MS - 1;
    expect(await store.hasPendingPairing()).toBe(true);
    clock += 1;
    const reopened = new VaultStore(local, session, makeClient, () => clock);
    expect(await reopened.hasPendingPairing()).toBe(false);
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
    await expect(reopened.pairFinish(PASSWORD)).rejects.toThrow("Najpierw sparuj");
  }, 30_000);

  it("pairFinish on an expired pairing says it expired and which device to remove on the phone (M6)", async () => {
    let clock = 5_000_000;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]), () => clock);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome (Linux)");
    clock += PAIRING_PENDING_MS;
    await expect(store.pairFinish(PASSWORD)).rejects.toThrow(
      "Parowanie wygasło. Poproś telefon o nowy kod. Na telefonie usuń „Chrome (Linux)” z „Urządzenia”.",
    );
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  }, 30_000);

  it("treats a pairing created in the future (clock moved back) as expired (M2)", async () => {
    let clock = 5_000_000;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store, session } = newBrowser(new Map([[PHONE_URL, phone]]), () => clock);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    clock -= 1;
    expect(await store.hasPendingPairing()).toBe(false);
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  }, 30_000);
});

describe("pairing with several typed addresses", () => {
  it("pairs at the first address that answers and keeps every typed one", async () => {
    const phone = await FakePhone.withVault(PASSWORD, []);
    const dead = "http://192.168.1.9:8787";
    const { store } = newBrowser(new Map([[SECOND_URL, phone]]));
    phone.offerPairing();
    await store.pairStart([dead, SECOND_URL], CODE, "Chrome");
    await store.pairFinish(PASSWORD);
    expect(await store.getAccount()).toMatchObject({ phoneUrls: [SECOND_URL, dead], lastPhoneUrl: SECOND_URL });
  }, 30_000);
});

describe("first sync after pairing", () => {
  it("pairFinish keeps the pairing and says so when the first sync fails", async () => {
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const network = new Map([[PHONE_URL, phone]]);
    const { store, session } = newBrowser(network);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    network.clear(); // sync mode went off between the code and the password

    const error = await store.pairFinish(PASSWORD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairedButSyncFailed);
    expect((error as Error).message).toBe(
      "Sparowano z telefonem, ale pierwsza synchronizacja się nie udała: Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?",
    );
    expect(await store.getAccount()).toBeDefined();
    expect(store.isUnlocked()).toBe(true);
    expect(await session.get(STORAGE_KEYS.pendingPairing)).toBeUndefined();
  }, 30_000);

  it("repair says the same, with what happened to the phone", async () => {
    const { store, phone, network } = await pairedBrowser();
    phone.offerPairing();
    const real = phone.handle.bind(phone);
    // The phone answers the pairing, then drops off before the sync.
    phone.handle = async (path, body) => {
      const reply = await real(path, body);
      if (path === "/p2p/v1/pair/finish") network.clear();
      return reply;
    };
    const error = await store.repair(PHONE_URL, CODE, PASSWORD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairedButSyncFailed);
    expect((error as PairedButSyncFailed).mode).toBe("paired");
    expect((error as Error).message).toContain("pierwsza synchronizacja się nie udała");
  }, 60_000);
});

describe("host permissions", () => {
  it("syncs only at addresses Chrome allows and names the skipped ones", async () => {
    const allowed = new Set([SECOND_URL]);
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store } = newBrowser(new Map([[PHONE_URL, phone], [SECOND_URL, phone]]), Date.now, async (u) => allowed.has(u) || u === PHONE_URL);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    await store.pairFinish(PASSWORD);
    allowed.clear();
    phone.addresses = [PHONE_URL, SECOND_URL];
    await store.sync(); // learns SECOND_URL
    await phone.addEntry("1", "bank.pl");

    expect(await store.sync()).toEqual({ skipped: [SECOND_URL] });
    expect(names(store)).toEqual(["bank.pl"]);
  }, 30_000);

  it("refuses to sync when no address is allowed, without contacting the phone", async () => {
    let allow = true;
    const phone = await FakePhone.withVault(PASSWORD, [PHONE_URL]);
    const { store } = newBrowser(new Map([[PHONE_URL, phone]]), Date.now, async () => allow);
    phone.offerPairing();
    await store.pairStart(PHONE_URL, CODE, "Chrome");
    await store.pairFinish(PASSWORD);
    allow = false;
    const calls = phone.calls.length;
    await expect(store.sync()).rejects.toThrow("Brak zgody Chrome");
    expect(phone.calls.length).toBe(calls);
  }, 30_000);
});

describe("Polish messages for raw phone errors", () => {
  it("a phone that forgot this browser asks to pair again", async () => {
    const { store, phone } = await pairedBrowser();
    phone.devices.length = 0;
    await expect(store.sync()).rejects.toThrow(
      "Telefon nie zna tej przeglądarki. Sparuj ją ponownie w „Adresy telefonu” → „Sparuj z innym telefonem / odtwórz telefon”.",
    );
  }, 30_000);

  it("a malformed answer says the phone answered wrongly", async () => {
    const { store, phone } = await pairedBrowser();
    phone.handle = async () => ({ status: 200, body: { message: 42 } });
    await expect(store.sync()).rejects.toThrow("Telefon odpowiedział niepoprawnie.");
  }, 30_000);
});
