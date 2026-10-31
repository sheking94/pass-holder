import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Database } from "./db.ts";

const config = loadConfig(process.env);
const db = new Database(config.dbPath);
const setupToken = db.getMeta() ? undefined : randomBytes(12).toString("hex");

const app = buildApp({
  db,
  setupToken,
  logger: true,
  ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) } } : {}),
});

await app.listen({ host: config.host, port: config.port });
if (setupToken) {
  app.log.warn(`Vault not set up yet. One-time setup token: ${setupToken}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
