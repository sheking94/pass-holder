import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveKeys,
  emptyVault,
  liveEntries,
  MIN_KDF,
  newVaultKey,
  syncVault,
  toBase64,
  unwrapVaultKey,
  upsertEntry,
  wrapVaultKey,
  type KdfParams,
  type SyncRequest,
  type SyncResponse,
} from "@passholder/core";
import { buildApp, type AppOptions } from "../src/app.ts";
import { Database } from "../src/db.ts";

const SETUP_TOKEN = "test-setup-token";
const PASSWORD = "correct horse battery staple";
// Cheapest parameters the server accepts, to keep tests fast.
const KDF: KdfParams = { alg: "argon2id", salt: toBase64(new Uint8Array(16).fill(7)), ...MIN_KDF };

const keys = await deriveKeys(PASSWORD, KDF);
const vaultKey = newVaultKey();
const wrappedVaultKey = await wrapVaultKey(keys.encKey, vaultKey);

let clock = 1_000_000;
const apps: ReturnType<typeof buildApp>[] = [];

function start(overrides: Partial<AppOptions> = {}) {
  const db = overrides.db ?? new Database(":memory:");
  const app = buildApp({ db, setupToken: SETUP_TOKEN, now: () => clock, ...overrides });
  apps.push(app);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setUp(app: ReturnType<typeof buildApp>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { setupToken: SETUP_TOKEN, kdf: KDF, authKey: toBase64(keys.authKey), wrappedVaultKey },
  });
}

async function logIn(app: ReturnType<typeof buildApp>, authKey = keys.authKey, remoteAddress = "127.0.0.1") {
  return app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(authKey) }, remoteAddress });
}

function transport(app: ReturnType<typeof buildApp>, token: string) {
  return async (request: SyncRequest): Promise<SyncResponse> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync",
      headers: { authorization: `Bearer ${token}` },
      payload: request,
    });
    if (res.statusCode !== 200) throw new Error(`sync failed: ${res.statusCode} ${res.body}`);
    return res.json();
  };
}

describe("setup", () => {
  it("creates the vault once, only with the setup token", async () => {
    const { app } = start();
    expect((await app.inject("/api/v1/status")).json()).toEqual({ initialized: false, version: "1" });
    expect((await app.inject("/api/v1/prelogin")).statusCode).toBe(404);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setupToken: "nope", kdf: KDF, authKey: toBase64(keys.authKey), wrappedVaultKey },
    });
    expect(wrong.statusCode).toBe(403);

    expect((await setUp(app)).statusCode).toBe(201);
    expect((await setUp(app)).statusCode).toBe(409);
    expect((await app.inject("/api/v1/status")).json()).toMatchObject({ initialized: true });
    expect((await app.inject("/api/v1/prelogin")).json()).toEqual({ kdf: KDF });
  });

  it("rejects weak KDF parameters", async () => {
    const { app } = start();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setupToken: SETUP_TOKEN, kdf: { ...KDF, memoryKiB: 1024 }, authKey: toBase64(keys.authKey), wrappedVaultKey },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("login", () => {
  it("returns a session and the wrapped vault key for the right password", async () => {
    const { app } = start();
    await setUp(app);
    const res = await logIn(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(await unwrapVaultKey(keys.encKey, body.wrappedVaultKey)).toEqual(vaultKey);
  });

  it("rejects a wrong password and locks out after 5 failures per minute", async () => {
    const { app } = start();
    await setUp(app);
    const other = await deriveKeys("wrong password", KDF);
    for (let i = 0; i < 5; i++) expect((await logIn(app, other.authKey)).statusCode).toBe(401);
    expect((await logIn(app)).statusCode).toBe(429);
    clock += 61_000;
    expect((await logIn(app)).statusCode).toBe(200);
  });

  it("limits failures from all addresses together, e.g. many IPv6 addresses (N3)", async () => {
    const { app } = start();
    await setUp(app);
    const other = await deriveKeys("wrong password", KDF);
    for (let i = 0; i < 20; i++) expect((await logIn(app, other.authKey, `fd00::${i + 1}`)).statusCode).toBe(401);
    expect((await logIn(app, keys.authKey, "fd00::99")).statusCode).toBe(429);
    clock += 61_000;
    expect((await logIn(app, keys.authKey, "fd00::99")).statusCode).toBe(200);
  });

  it("expires sessions", async () => {
    const { app } = start();
    await setUp(app);
    const { token } = (await logIn(app)).json();
    const send = () =>
      app.inject({ method: "POST", url: "/api/v1/sync", headers: { authorization: `Bearer ${token}` }, payload: { sinceRevision: 0, changes: [] } });
    expect((await send()).statusCode).toBe(200);
    clock += 15 * 60_000;
    expect((await send()).statusCode).toBe(401);
  });
});

describe("sync over HTTP", () => {
  it("requires a session", async () => {
    const { app } = start();
    await setUp(app);
    const res = await app.inject({ method: "POST", url: "/api/v1/sync", payload: { sinceRevision: 0, changes: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("moves entries between two devices", async () => {
    const { app } = start();
    await setUp(app);
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", { name: "a.com", username: "me", password: "p1" }, 100);
    upsertEntry(phone, "2", { name: "b.com", username: "me", password: "p2" }, 100);
    await syncVault(phone, vaultKey, transport(app, (await logIn(app)).json().token));
    await syncVault(browser, vaultKey, transport(app, (await logIn(app)).json().token));
    expect(liveEntries(browser).map((e) => e.data.name).sort()).toEqual(["a.com", "b.com"]);
  });

  it("rolls back the whole request when one change is invalid", async () => {
    const { app, db } = start();
    await setUp(app);
    const { token } = (await logIn(app)).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sinceRevision: 0,
        changes: [
          { id: "ok", baseRevision: 0, deleted: false, blob: "AQ==" },
          { id: "bad", baseRevision: 5, deleted: false, blob: "AQ==" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(db.currentRevision()).toBe(0);
  });

  it("keeps data after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "passholder-"));
    try {
      const path = join(dir, "vault.db");
      const first = start({ db: new Database(path) });
      await setUp(first.app);
      const phone = emptyVault();
      upsertEntry(phone, "1", { name: "a.com", username: "me", password: "p1" }, 100);
      await syncVault(phone, vaultKey, transport(first.app, (await logIn(first.app)).json().token));
      await first.app.close();
      first.db.close();

      const second = start({ db: new Database(path), setupToken: undefined });
      const browser = emptyVault();
      await syncVault(browser, vaultKey, transport(second.app, (await logIn(second.app)).json().token));
      expect(liveEntries(browser).map((e) => e.data.name)).toEqual(["a.com"]);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
