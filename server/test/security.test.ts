import { afterEach, describe, expect, it } from "vitest";
import { deriveKeys, MIN_KDF, newVaultKey, toBase64, wrapVaultKey, type KdfParams } from "@passholder/core";
import { buildApp, type AppOptions } from "../src/app.ts";
import { Database } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";

const SETUP_TOKEN = "test-setup-token";
const KDF: KdfParams = { alg: "argon2id", salt: toBase64(new Uint8Array(16).fill(7)), ...MIN_KDF };
const keys = await deriveKeys("correct horse battery staple", KDF);
const wrappedVaultKey = await wrapVaultKey(keys.encKey, newVaultKey());

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

const setupBody = (overrides: Record<string, unknown> = {}) => ({
  setupToken: SETUP_TOKEN,
  kdf: KDF,
  authKey: toBase64(keys.authKey),
  wrappedVaultKey,
  ...overrides,
});

async function ready(overrides: Partial<AppOptions> = {}) {
  const started = start(overrides);
  const res = await started.app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody() });
  expect(res.statusCode).toBe(201);
  return started;
}

async function token(app: ReturnType<typeof buildApp>) {
  const res = await app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(keys.authKey) } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const sync = (app: ReturnType<typeof buildApp>, payload: unknown, authorization?: string) =>
  app.inject({ method: "POST", url: "/api/v1/sync", payload: payload as object, headers: authorization ? { authorization } : {} });

describe("setup hardening", () => {
  it("cannot be done at all when the server started with an existing vault (no token)", async () => {
    const res = await start({ setupToken: undefined }).app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody({ setupToken: "" }) });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an auth key that is not 32 bytes and an unknown KDF", async () => {
    const { app } = start();
    expect((await app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody({ authKey: toBase64(new Uint8Array(16)) }) })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody({ kdf: { ...KDF, alg: "md5" } }) })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody({ kdf: { ...KDF, memoryKiB: 2 ** 23 } }) })).statusCode).toBe(400);
    expect((await app.inject("/api/v1/status")).json()).toMatchObject({ initialized: false });
  });

  it("drops unknown fields instead of storing them (Fastify removes them before the handler runs)", async () => {
    const { app, db } = start();
    const res = await app.inject({ method: "POST", url: "/api/v1/setup", payload: setupBody({ admin: true, kdf: { ...KDF, extra: 1 } }) });
    expect(res.statusCode).toBe(201);
    expect(db.getMeta()!.kdf).toEqual(KDF);
  });

  it("never stores or returns the auth key itself", async () => {
    const { app, db } = await ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(keys.authKey) } });
    expect(login.body).not.toContain(toBase64(keys.authKey));
    expect(Buffer.from(db.getMeta()!.authHash).toString("base64")).not.toBe(toBase64(keys.authKey));
    expect((await app.inject("/api/v1/prelogin")).body).not.toContain("auth");
  });
});

describe("login hardening", () => {
  it("counts a malformed auth key as a failed attempt", async () => {
    const { app } = await ready({ maxLoginFailures: 2 });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(new Uint8Array(5)) } });
      expect(res.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(keys.authKey) } })).statusCode).toBe(429);
  });

  it("a successful login resets the failure counter", async () => {
    const { app } = await ready({ maxLoginFailures: 3 });
    const wrong = { authKey: toBase64(new Uint8Array(32)) };
    for (let i = 0; i < 2; i++) await app.inject({ method: "POST", url: "/api/v1/session", payload: wrong });
    await token(app);
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: "/api/v1/session", payload: wrong })).statusCode).toBe(401);
    await token(app);
  });

  it("gives every login a different token", async () => {
    const { app } = await ready();
    expect(await token(app)).not.toBe(await token(app));
  });

  it("returns 404 before setup instead of letting anyone log in", async () => {
    const res = await start().app.inject({ method: "POST", url: "/api/v1/session", payload: { authKey: toBase64(keys.authKey) } });
    expect(res.statusCode).toBe(404);
  });
});

describe("sync authorization and validation", () => {
  const empty = { sinceRevision: 0, changes: [] };

  it("accepts only a valid Bearer token", async () => {
    const { app } = await ready();
    const t = await token(app);
    expect((await sync(app, empty, `Bearer ${t}`)).statusCode).toBe(200);
    expect((await sync(app, empty, t)).statusCode).toBe(401); // no "Bearer "
    expect((await sync(app, empty, `Bearer ${t}x`)).statusCode).toBe(401);
    expect((await sync(app, empty, "Bearer ")).statusCode).toBe(401);
    expect((await sync(app, empty, `Basic ${t}`)).statusCode).toBe(401);
  });

  it("forgets sessions on restart: the Pi is switched off between syncs", async () => {
    const first = await ready();
    const t = await token(first.app);
    const second = start({ db: first.db, setupToken: undefined });
    expect((await sync(second.app, empty, `Bearer ${t}`)).statusCode).toBe(401);
  });

  it("validates the request body", async () => {
    const { app, db } = await ready();
    const auth = `Bearer ${await token(app)}`;
    const change = { id: "1", baseRevision: 0, deleted: false, blob: "AQ==" };
    const bad = [
      {},
      { sinceRevision: -1, changes: [] },
      { sinceRevision: 0.5, changes: [] },
      { sinceRevision: 0, changes: [{ ...change, id: "" }] },
      { sinceRevision: 0, changes: [{ ...change, id: "x".repeat(65) }] },
      { sinceRevision: 0, changes: [{ ...change, blob: "not base64!" }] },
      { sinceRevision: 0, changes: [{ ...change, baseRevision: -1 }] },
      { sinceRevision: 0, changes: [change, change] }, // duplicate id
    ];
    for (const body of bad) expect((await sync(app, body, auth)).statusCode, JSON.stringify(body)).toBe(400);
    expect(db.currentRevision()).toBe(0);
  });

  it("reports a stale base revision as a conflict, not an error", async () => {
    const { app } = await ready();
    const auth = `Bearer ${await token(app)}`;
    const change = { id: "1", baseRevision: 0, deleted: false, blob: "AQ==" };
    expect((await sync(app, { sinceRevision: 0, changes: [change] }, auth)).json().accepted).toEqual([{ id: "1", revision: 1 }]);
    const again = (await sync(app, { sinceRevision: 1, changes: [{ ...change, blob: "Ag==" }] }, auth)).json();
    expect(again.accepted).toEqual([]);
    expect(again.conflicts).toEqual([{ id: "1", revision: 1, deleted: false, blob: "AQ==" }]);
  });
});

describe("config", () => {
  it("requires TLS unless explicitly told to use plain HTTP", () => {
    expect(() => loadConfig({})).toThrow("PASSHOLDER_TLS_CERT");
    expect(loadConfig({ PASSHOLDER_INSECURE_HTTP: "1" }).tls).toBeUndefined();
    expect(loadConfig({ PASSHOLDER_TLS_CERT: "c", PASSHOLDER_TLS_KEY: "k" })).toMatchObject({ port: 8443, tls: { certPath: "c", keyPath: "k" } });
  });

  it("rejects an invalid port", () => {
    for (const port of ["0", "70000", "abc", "80.5"]) {
      expect(() => loadConfig({ PASSHOLDER_INSECURE_HTTP: "1", PASSHOLDER_PORT: port })).toThrow("PORT");
    }
  });
});
