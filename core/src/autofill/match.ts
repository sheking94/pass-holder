export interface MatchCandidate {
  name: string;
  urls: readonly string[];
}

export type MatchKind = "exact" | "subdomain";

interface ParsedUrl {
  scheme: "http:" | "https:";
  host: string;
  /** Port as written in the URL; empty means the scheme default. */
  port: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function parse(raw: string): ParsedUrl | undefined {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") return undefined;
  return { scheme: url.protocol, host, port: url.port };
}

function isExactOnlyHost(host: string): boolean {
  return host === "localhost" || host.startsWith("[") || IPV4.test(host);
}

/** Matches one saved address against a page address (spec 3.1, rules 1-6). */
export function matchUrl(pageUrl: string, savedUrl: string): MatchKind | undefined {
  const page = parse(pageUrl);
  const saved = parse(savedUrl);
  if (!page || !saved) return undefined;

  if (saved.scheme === "https:" && page.scheme !== "https:") return undefined;
  // URL drops default ports, so an empty page port is the scheme default.
  if (saved.port === "" ? page.port !== "" : saved.port !== (page.port || (page.scheme === "https:" ? "443" : "80"))) {
    return undefined;
  }

  if (page.host === saved.host) return "exact";
  if (isExactOnlyHost(saved.host) || isExactOnlyHost(page.host)) return undefined;
  return page.host.endsWith(`.${saved.host}`) ? "subdomain" : undefined;
}

/** Items whose best saved address matches the page: exact host first, then subdomains, each group sorted by name. */
export function matchLogins<T>(pageUrl: string, items: readonly T[], candidate: (item: T) => MatchCandidate): T[] {
  const collator = new Intl.Collator("pl");
  const matched: { item: T; name: string; rank: number }[] = [];
  for (const item of items) {
    const { name, urls } = candidate(item);
    let rank = Infinity;
    for (const url of urls) {
      const kind = matchUrl(pageUrl, url);
      if (kind === "exact") rank = 0;
      else if (kind === "subdomain") rank = Math.min(rank, 1);
    }
    if (rank !== Infinity) matched.push({ item, name, rank });
  }
  matched.sort((a, b) => a.rank - b.rank || collator.compare(a.name, b.name));
  return matched.map((m) => m.item);
}
