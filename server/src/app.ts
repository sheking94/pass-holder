import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  MAX_KDF,
  MIN_KDF,
  assertKdfParamsAcceptable,
  authHash,
  fromBase64,
  processSync,
  type KdfParams,
  type SyncRequest,
} from "@passholder/core";
import type { Database } from "./db.ts";

export interface AppOptions {
  db: Database;
  /** Required to create the vault. Undefined once the vault exists. */
  setupToken?: string;
  sessionTtlMs?: number;
  /** Failed logins allowed per IP within loginWindowMs. */
  maxLoginFailures?: number;
  loginWindowMs?: number;
  now?: () => number;
  https?: { key: Buffer; cert: Buffer };
  logger?: boolean;
}

const base64 = { type: "string", pattern: "^[A-Za-z0-9+/]*={0,2}$", maxLength: 1_000_000 } as const;

const kdfSchema = {
  type: "object",
  required: ["alg", "salt", "memoryKiB", "iterations", "parallelism"],
  additionalProperties: false,
  properties: {
    alg: { const: "argon2id" },
    salt: base64,
    // Same bounds as the clients check (core/src/kdf.ts), so the schema and the code cannot disagree.
    memoryKiB: { type: "integer", minimum: MIN_KDF.memoryKiB, maximum: MAX_KDF.memoryKiB },
    iterations: { type: "integer", minimum: MIN_KDF.iterations, maximum: MAX_KDF.iterations },
    parallelism: { type: "integer", minimum: MIN_KDF.parallelism, maximum: MAX_KDF.parallelism },
  },
} as const;

const recordProps = {
  id: { type: "string", minLength: 1, maxLength: 64 },
  deleted: { type: "boolean" },
  blob: base64,
} as const;

function decodeKey(value: string): Uint8Array | undefined {
  try {
    const bytes = fromBase64(value);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options;
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000;
  const maxLoginFailures = options.maxLoginFailures ?? 5;
  const loginWindowMs = options.loginWindowMs ?? 60_000;
  let setupToken = options.setupToken;

  const sessions = new Map<string, number>();
  const loginFailures = new Map<string, number[]>();

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    ...(options.https ? { https: options.https } : {}),
  });

  function recentFailures(ip: string): number[] {
    const recent = (loginFailures.get(ip) ?? []).filter((t) => now() - t < loginWindowMs);
    loginFailures.set(ip, recent);
    return recent;
  }

  function requireSession(request: FastifyRequest): boolean {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expiresAt = sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  app.get("/api/v1/status", async () => ({ initialized: db.getMeta() !== undefined, version: "1" }));

  app.post<{ Body: { setupToken: string; kdf: KdfParams; authKey: string; wrappedVaultKey: string } }>(
    "/api/v1/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["setupToken", "kdf", "authKey", "wrappedVaultKey"],
          additionalProperties: false,
          properties: { setupToken: { type: "string", maxLength: 256 }, kdf: kdfSchema, authKey: base64, wrappedVaultKey: base64 },
        },
      },
    },
    async (request, reply) => {
      if (db.getMeta()) return reply.code(409).send({ error: "Vault already exists" });
      const expected = Buffer.from(setupToken ?? "");
      const given = Buffer.from(request.body.setupToken);
      if (!setupToken || !sameBytes(expected, given)) return reply.code(403).send({ error: "Invalid setup token" });
      try {
        assertKdfParamsAcceptable(request.body.kdf);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      const authKey = decodeKey(request.body.authKey);
      if (!authKey) return reply.code(400).send({ error: "authKey must be 32 bytes" });
      db.initialize({ kdf: request.body.kdf, authHash: authHash(authKey), wrappedVaultKey: request.body.wrappedVaultKey }, now());
      setupToken = undefined;
      return reply.code(201).send({});
    },
  );

  app.get("/api/v1/prelogin", async (_request, reply) => {
    const meta = db.getMeta();
    if (!meta) return reply.code(404).send({ error: "Vault not set up" });
    return { kdf: meta.kdf };
  });

  app.post<{ Body: { authKey: string } }>(
    "/api/v1/session",
    {
      schema: {
        body: { type: "object", required: ["authKey"], additionalProperties: false, properties: { authKey: base64 } },
      },
    },
    async (request, reply) => {
      const meta = db.getMeta();
      if (!meta) return reply.code(404).send({ error: "Vault not set up" });
      const failures = recentFailures(request.ip);
      if (failures.length >= maxLoginFailures) return reply.code(429).send({ error: "Too many attempts, wait a minute" });
      const authKey = decodeKey(request.body.authKey);
      if (!authKey || !sameBytes(authHash(authKey), meta.authHash)) {
        failures.push(now());
        return reply.code(401).send({ error: "Wrong master password" });
      }
      loginFailures.delete(request.ip);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + sessionTtlMs;
      sessions.set(token, expiresAt);
      return { token, expiresAt, wrappedVaultKey: meta.wrappedVaultKey };
    },
  );

  app.post<{ Body: SyncRequest }>(
    "/api/v1/sync",
    {
      schema: {
        body: {
          type: "object",
          required: ["sinceRevision", "changes"],
          additionalProperties: false,
          properties: {
            sinceRevision: { type: "integer", minimum: 0 },
            changes: {
              type: "array",
              maxItems: 10_000,
              items: {
                type: "object",
                required: ["id", "baseRevision", "deleted", "blob"],
                additionalProperties: false,
                properties: { ...recordProps, baseRevision: { type: "integer", minimum: 0 } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireSession(request)) return reply.code(401).send({ error: "Log in first" });
      try {
        return db.transaction(() => processSync(db, request.body));
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  return app;
}
