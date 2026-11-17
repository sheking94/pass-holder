// One normalization of web addresses for autofill matching, saving and import names (review V3 CS5).

/** An http(s) address as PassHolder compares it. */
export interface WebAddress {
  scheme: "http:" | "https:";
  /** See normalizeHost. */
  host: string;
  /** Port as written in the URL; empty means the scheme default (URL drops it). */
  port: string;
}

/**
 * Host as PassHolder compares it: lower case, then without a leading "www.", then without one trailing dot. The
 * order matters only for "www.", which becomes "" (no host): the save vectors fix that ("empty host after www
 * removal"); autofill matching used the other order until review V3 CS5 and now refuses "www." too.
 */
export function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/**
 * `text` (trimmed) as an http(s) address with a normalized host, or undefined when it is not one or its host is
 * empty. `assumeHttps`: text without "://" is read as an https address (saved addresses are stored that way).
 */
export function parseWebAddress(
  text: string,
  { assumeHttps }: { assumeHttps: boolean },
): WebAddress | undefined {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(assumeHttps && !trimmed.includes("://") ? `https://${trimmed}` : trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = normalizeHost(url.hostname);
  if (host === "") return undefined;
  return { scheme: url.protocol, host, port: url.port };
}

/** Normalized host of any address (any scheme, "https://" assumed without one), or undefined when it has none. */
export function hostOf(text: string): string | undefined {
  try {
    const host = normalizeHost(new URL(text.includes("://") ? text : `https://${text}`).hostname);
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}
