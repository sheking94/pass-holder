const DEFAULT_PORT = { "http:": "80", "https:": "443" } as const;

/** Address to save a login under for a page (spec 3.1), or null when the page cannot be saved. */
export function saveUrl(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (host === "") return null;
  // URL already drops the scheme's default port.
  const withPort =
    url.port !== "" && url.port !== DEFAULT_PORT[url.protocol] ? `${host}:${url.port}` : host;
  return url.protocol === "https:" ? withPort : `http://${withPort}`;
}

/** Host of a `saveUrl` result without scheme and port. */
export function saveName(url: string): string {
  const rest = url.replace(/^https?:\/\//, "");
  const end = rest.startsWith("[") ? rest.indexOf("]") + 1 : rest.search(/:/);
  return end > 0 ? rest.slice(0, end) : rest;
}
