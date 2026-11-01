import { ApiError, type ServerClient } from "./api.ts";

/**
 * How long the quick status check of one address may take before the next address is tried.
 * Without it, an address that is not reachable from where you are (the home IP when you are out,
 * the Tailscale IP with the VPN off) could keep fetch waiting for half a minute or more.
 */
export const PROBE_TIMEOUT_MS = 4000;

/** Trims, drops trailing slashes, empty entries and duplicates; keeps the order they were typed in. */
export function normalizeServerUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw.trim().replace(/\/+$/, "");
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The address that worked last time goes first, the others follow in the order they were entered. */
export function orderForTrying(urls: readonly string[], lastWorking?: string): string[] {
  if (!lastWorking || !urls.includes(lastWorking)) return [...urls];
  return [lastWorking, ...urls.filter((u) => u !== lastWorking)];
}

/**
 * Finds an address at which the server answers. With one address there is nothing to choose, so it is
 * returned without a check (the request itself reports if the server is down). With more, each one gets
 * a short GET /status in turn and the first that answers wins. Any failure (no route, timeout,
 * certificate Chrome does not trust, an error status) means "not here, try the next one".
 */
export async function pickServer(
  urls: readonly string[],
  makeClient: (url: string) => ServerClient,
  lastWorking?: string,
): Promise<{ url: string; client: ServerClient }> {
  const ordered = orderForTrying(urls, lastWorking);
  const [only] = ordered;
  if (only === undefined) throw new Error("Brak adresu serwera");
  if (ordered.length === 1) return { url: only, client: makeClient(only) };
  for (const url of ordered) {
    const client = makeClient(url);
    try {
      await client.status(PROBE_TIMEOUT_MS);
      return { url, client };
    } catch {
      // Not reachable from here; try the next address.
    }
  }
  throw new ApiError(
    0,
    `Serwer nie odpowiada pod żadnym adresem (${ordered.join(", ")}). Czy Raspberry Pi jest włączone? Spoza domu potrzebny jest też włączony Tailscale.`,
  );
}
