import { ApiError } from "./phone-client.ts";

/**
 * How long the quick ping of one address may take before the next address is tried.
 * Without it, an address that is not reachable from where you are (the home IP when you are out,
 * the Tailscale IP with the VPN off) could keep fetch waiting for half a minute or more.
 */
export const PROBE_TIMEOUT_MS = 4000;

/** The port of the phone's sync server (PhoneSync.PORT), used when an address has none. */
export const PHONE_PORT = 8787;

/**
 * The phone answers only requests whose Host is an IPv4 literal or localhost (anything else gets 403), and
 * only over plain HTTP: the Noise handshake inside does the encryption and authentication.
 */
const OCTET = String.raw`(0|[1-9]\d{0,2})`;
/** No leading zeros in an octet: the WHATWG URL parser would read "010" as octal (8). */
const PHONE_URL = new RegExp(
  String.raw`^(?:http:\/\/)?(localhost|${OCTET}\.${OCTET}\.${OCTET}\.${OCTET})(?::(\d{1,5}))?\/*$`,
  "i",
);

const invalidPhoneUrl = (raw: string) =>
  `Nieprawidłowy adres telefonu „${raw}”. Wpisz adres IPv4 z ekranu Synchronizacja w telefonie, np. http://192.168.1.5:${PHONE_PORT}.`;

/** `http://<IPv4>:<port>` for an address like "192.168.1.5", "192.168.1.5:8787" or "http://192.168.1.5:8787/"; undefined if unusable. */
export function normalizePhoneUrl(raw: string): string | undefined {
  const m = PHONE_URL.exec(raw.trim());
  if (!m) return undefined;
  const [, host, ...rest] = m;
  const octets = rest.slice(0, 4);
  if (octets[0] !== undefined && octets.some((o) => Number(o) > 255)) return undefined;
  const port = rest[4] === undefined ? PHONE_PORT : Number(rest[4]);
  if (port < 1 || port > 65535) return undefined;
  return `http://${host!.toLowerCase()}:${port}`;
}

/** Normalizes typed addresses, drops empty entries and duplicates, keeps their order; throws on an unusable one. */
export function normalizePhoneUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    if (!raw.trim()) continue;
    const url = normalizePhoneUrl(raw);
    if (url === undefined) throw new Error(invalidPhoneUrl(raw.trim()));
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** Addresses the phone reported, normalized; those the extension cannot use (e.g. IPv6 or names) are skipped. */
export function learnedPhoneUrls(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const address of addresses) {
    const url = normalizePhoneUrl(address);
    if (url !== undefined && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The address that worked last time goes first, the others follow in the order they were entered. */
export function orderForTrying(urls: readonly string[], lastWorking?: string): string[] {
  if (!lastWorking || !urls.includes(lastWorking)) return [...urls];
  return [lastWorking, ...urls.filter((u) => u !== lastWorking)];
}

/** What pickPhone needs of a client: a quick check that the other side answers. */
export interface Probe {
  status(timeoutMs?: number): Promise<unknown>;
}

/**
 * Finds an address at which the phone answers. With one address there is nothing to choose, so it is
 * returned without a check (the request itself reports if the phone is not there). With more, each one
 * gets a ping with PROBE_TIMEOUT_MS in turn and the first that answers wins. Any failure (no route,
 * timeout, an error status) means "not here, try the next one".
 */
export async function pickPhone<C extends Probe>(
  urls: readonly string[],
  makeClient: (url: string) => C,
  lastWorking?: string,
): Promise<{ url: string; client: C }> {
  const ordered = orderForTrying(urls, lastWorking);
  const [only] = ordered;
  if (only === undefined) throw new Error("Brak adresu telefonu");
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
    `Telefon nie odpowiada pod żadnym adresem (${ordered.join(", ")}). Czy tryb Synchronizacja jest włączony? Spoza domu potrzebny jest też włączony Tailscale.`,
  );
}
