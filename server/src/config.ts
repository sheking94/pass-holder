export interface Config {
  host: string;
  port: number;
  dbPath: string;
  tls?: { certPath: string; keyPath: string };
}

/** Reads settings from environment variables (see deploy/passholder.env.example). */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const certPath = env.PASSHOLDER_TLS_CERT;
  const keyPath = env.PASSHOLDER_TLS_KEY;
  const insecure = env.PASSHOLDER_INSECURE_HTTP === "1";
  if (!insecure && (!certPath || !keyPath)) {
    throw new Error("Set PASSHOLDER_TLS_CERT and PASSHOLDER_TLS_KEY, or PASSHOLDER_INSECURE_HTTP=1 for local development");
  }
  const port = Number(env.PASSHOLDER_PORT ?? 8443);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid PASSHOLDER_PORT");
  return {
    host: env.PASSHOLDER_HOST ?? "0.0.0.0",
    port,
    dbPath: env.PASSHOLDER_DB ?? "passholder.db",
    ...(insecure ? {} : { tls: { certPath: certPath!, keyPath: keyPath! } }),
  };
}
